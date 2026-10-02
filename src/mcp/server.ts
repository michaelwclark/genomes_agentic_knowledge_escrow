import { statSync } from 'node:fs';
import http from 'node:http';
import type { Readable } from 'node:stream';
import { handleJsonRpc } from './json-rpc.js';
import type { MemoryRouter } from '../router.js';

type StdioFraming = 'line' | 'headers';

const PARENT_CHECK_INTERVAL_MS = 60_000;
// Backstop only (normal shutdown finishes well under this via the awaited
// drain below). Measured cold-start-to-EOF-response on the packaged SEA
// (model load + sqlite open + one memory_write) at ~150ms locally; 30s gives
// generous headroom for a slower disk or a much larger write without
// masking a real hang.
const SHUTDOWN_FORCE_EXIT_MS = 30_000;

export type StdioLifecycleOptions = {
  stdin?: Readable;
  exit?: (code: number) => void;
  getParentPid?: () => number;
  parentCheckIntervalMs?: number;
  getBuildMtimeMs?: () => number | undefined;
};

export function startStdioServer(router: MemoryRouter, lifecycle: StdioLifecycleOptions = {}): void {
  const stdin = lifecycle.stdin ?? process.stdin;
  const exit = lifecycle.exit ?? ((code: number) => process.exit(code));
  const getParentPid = lifecycle.getParentPid ?? (() => process.ppid);
  const parentCheckIntervalMs = lifecycle.parentCheckIntervalMs ?? PARENT_CHECK_INTERVAL_MS;
  const getBuildMtimeMs = lifecycle.getBuildMtimeMs ?? entryScriptMtimeMs;

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let framing: StdioFraming | undefined;

  // Requests dispatched to handleJsonRpc but not yet responded to. Tracked
  // so shutdown can wait for every outstanding request instead of racing
  // ahead of one: a client that pipes a request then immediately closes
  // stdin (every short-lived CLI/test invocation of this bridge) could
  // otherwise see `router.close()` tear down storage before a write lands
  // (2026-10-01: observed exactly this — ledger empty after initialize +
  // memory_write + EOF). Framing/buffer parsing below stays synchronous and
  // in order (it mutates shared `buffer`/`framing` state); only the actual
  // handleJsonRpc call + response write for each parsed message runs
  // concurrently, so one slow request (a slow external read, a large
  // embedding call) never head-of-line-blocks requests after it — the
  // previous version of this fix serialized all requests through one
  // promise chain, which would have reintroduced that stall.
  const inflight = new Set<Promise<void>>();

  function dispatch(message: unknown, activeFraming: StdioFraming): void {
    const task = handleJsonRpc(router, message as Parameters<typeof handleJsonRpc>[1])
      .then((response) => {
        if (response) writeMessage(response, activeFraming);
      })
      .catch((error) => {
        process.stderr.write(
          `escrow: error handling request: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }

  // Extracts every complete message currently in `buffer`, advancing past
  // each one (including a malformed one — see readLineMessage/readMessage)
  // so a single bad line can never wedge the bridge: without advancing
  // `buffer` past it, every later chunk would re-hit the same bad line
  // forever and no later request would ever be answered.
  function drainCompleteMessages(input: Buffer): void {
    buffer = Buffer.concat([buffer, input]);
    while (true) {
      // Claude Code and the current MCP spec speak newline-delimited JSON;
      // LSP-style clients send Content-Length headers. Detect from the first
      // byte and stay sticky so responses match the client's framing.
      if (!framing) {
        const preview = buffer.toString('utf8').trimStart();
        if (!preview) break;
        framing = preview.startsWith('{') ? 'line' : 'headers';
      }
      const parsed = framing === 'line' ? readLineMessage(buffer) : readMessage(buffer);
      if (!parsed) break;
      buffer = parsed.remaining;
      if (parsed.message === undefined) continue;
      dispatch(parsed.message, framing);
    }
  }

  stdin.on('data', (chunk) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      drainCompleteMessages(input);
    } catch (error) {
      // readLineMessage/readMessage no longer throw on malformed input (both
      // advance past it instead), so this only guards an unexpected error;
      // log rather than let it become an unhandled exception mid-session.
      process.stderr.write(
        `escrow: error processing stdio input: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  });

  // A trailing message with no terminating newline (common when a client
  // writes its last request and closes stdin in the same breath, e.g. a
  // `printf ... | escrow` one-shot) never satisfies readLineMessage's
  // newline search and would otherwise sit in `buffer` unprocessed forever.
  // Salvage it if it's complete JSON. Line-framing only: headers framing has
  // no length prefix to safely guess a boundary from.
  function flushTrailingBuffer(): void {
    if (framing === 'headers') return;
    const line = buffer.toString('utf8').trim();
    buffer = Buffer.alloc(0);
    if (!line) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // genuinely incomplete/corrupt; nothing safe to salvage
    }
    dispatch(message, framing ?? 'line');
  }

  function flushStdout(): Promise<void> {
    return new Promise((resolve) => process.stdout.write('', () => resolve()));
  }

  // One bridge is spawned per Claude/Codex session and the session owns our
  // stdin; the router's open handles would otherwise keep the process alive
  // forever after the session dies (observed empirically: dozens of leaked
  // bridges accumulate on a host that never saw stdin EOF). Exit on stdin
  // EOF, with a parent-liveness backstop for parents
  // that die without closing the pipe.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(parentCheck);
    const forceExitTimer = setTimeout(() => exit(0), SHUTDOWN_FORCE_EXIT_MS);
    forceExitTimer.unref();
    void (async () => {
      // 'end'/'close' fire once all 'data' chunks have been synchronously
      // handed to drainCompleteMessages, so `buffer` already reflects every
      // byte received; salvage a trailing unterminated message first (this
      // adds to `inflight` if it finds one), then wait for every dispatched
      // request — including that salvage — to finish before closing
      // storage, then flush stdout (pipe writes can be asynchronous;
      // process.exit would otherwise drop a response still in flight)
      // before exiting.
      flushTrailingBuffer();
      await Promise.allSettled([...inflight]);
      await router.close().catch(() => undefined);
      await flushStdout().catch(() => undefined);
      exit(0);
    })();
  };
  stdin.once('end', shutdown);
  stdin.once('close', shutdown);
  stdin.once('error', shutdown);

  // A bridge also lives for its session's whole lifetime, so a deploy that
  // rebuilds dist/ leaves running bridges executing the old code from memory
  // (2026-08-26: bridges spawned before the v0.4.1 ledger fix kept reproducing
  // the fixed bug for hours after the fix was live). Watch the entry script's
  // mtime and exit through the same shutdown path when it changes, so the MCP
  // client sees the closed pipe and respawns a bridge on the new build.
  const initialBuildMtimeMs = getBuildMtimeMs();

  const initialParentPid = getParentPid();
  const parentCheck = setInterval(() => {
    const parentPid = getParentPid();
    if (parentPid === 1 || parentPid !== initialParentPid) {
      shutdown();
      return;
    }
    if (initialBuildMtimeMs === undefined) return;
    const buildMtimeMs = getBuildMtimeMs();
    // A missing entry script (the clean step mid-rebuild) is transient; only a
    // different on-disk build proves this process is stale.
    if (buildMtimeMs !== undefined && buildMtimeMs !== initialBuildMtimeMs) shutdown();
  }, parentCheckIntervalMs);
  parentCheck.unref();
}

function entryScriptMtimeMs(): number | undefined {
  // Verified empirically with a throwaway probe SEA (not Node's docs, which
  // are easy to misread here): a single-executable application does NOT
  // drop the executable path the way `node script.js arg` drops nothing —
  // its argv is [execPath, execPath, ...args], i.e. the executable path is
  // duplicated into argv[1] exactly where a real script path would be. So
  // for the packaged SEA started as `exec "$SEA_BIN" mcp`
  // (plugins/.../bin/escrow), argv[1] is the SEA binary's own on-disk path —
  // a real file — and this watch fires only if that installed binary file
  // is later overwritten (e.g. a plugin reinstall/upgrade replacing it
  // while a bridge from the old binary is still running), which is exactly
  // the staleness this watch exists to catch. When run as plain
  // `node server/escrow.cjs mcp` (node-path fallback) or `node dist/cli.js
  // mcp`, argv[1] is likewise the real script path and the watch behaves
  // the same way for that build artifact.
  const entry = process.argv[1];
  if (!entry) return undefined;
  try {
    const stat = statSync(entry);
    // A directory's mtime changes whenever an entry inside it is added or
    // removed, which would cause a spurious self-exit unrelated to any
    // rebuild of this entry script; only a real file's mtime is meaningful.
    if (!stat.isFile()) return undefined;
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

export function startHttpServer(router: MemoryRouter, host: string, port: number): http.Server {
  // Rejections here would otherwise be unhandled and kill the daemon — a bad
  // health probe must degrade to a 5xx, never a process exit + restart loop.
  const server = http.createServer((req, res) => {
    void handleHttpRequest(router, req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(port, host);
  return server;
}

async function handleHttpRequest(
  router: MemoryRouter,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    const health = await router.healthReport(false);
    respondJson(res, health.ok ? 200 : 503, health);
    return;
  }
  if (req.method === 'GET' && req.url === '/readyz') {
    const health = await router.healthReport(true);
    respondJson(res, health.ok ? 200 : 503, health);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/analytics')) {
    respondJson(res, 200, await router.analytics(readHours(req.url)));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/metrics')) {
    const body = await router.getMetricsStore().prometheus(readHours(req.url));
    respondText(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/mcp') {
    respondJson(res, 404, { error: 'not_found' });
    return;
  }
  try {
    const body = await readBody(req);
    const request = JSON.parse(body.toString('utf8'));
    const response = await handleJsonRpc(router, request);
    respondJson(res, 200, response ?? {});
  } catch (error) {
    respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function readHours(url: string): number {
  const parsed = new URL(url, 'http://localhost');
  const hours = Number(parsed.searchParams.get('hours') ?? '24');
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

// Both readers always return `remaining` already advanced past whatever they
// consumed, even when the consumed bytes turn out to be malformed. Returning
// `{ message: undefined, remaining }` (instead of throwing) on a parse
// failure is deliberate: a throw here would leave `buffer` unchanged, so
// every later chunk would re-hit the same bad bytes forever and no later
// request on the connection would ever be answered.
function readMessage(buffer: Buffer): { message: unknown; remaining: Buffer } | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return undefined;
  const header = buffer.slice(0, headerEnd).toString('utf8');
  const bodyStart = headerEnd + 4;
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    process.stderr.write('escrow: dropping stdio frame with no Content-Length header\n');
    return { message: undefined, remaining: buffer.slice(bodyStart) };
  }
  const length = Number(match[1]);
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return undefined;
  const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
  const remaining = buffer.slice(bodyEnd);
  try {
    return { message: JSON.parse(body), remaining };
  } catch (error) {
    process.stderr.write(
      `escrow: dropping malformed stdio frame body: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return { message: undefined, remaining };
  }
}

function readLineMessage(buffer: Buffer): { message: unknown; remaining: Buffer } | undefined {
  const newline = buffer.indexOf('\n');
  if (newline === -1) return undefined;
  const line = buffer.slice(0, newline).toString('utf8').trim();
  const remaining = buffer.slice(newline + 1);
  if (!line) return { message: undefined, remaining };
  try {
    return { message: JSON.parse(line), remaining };
  } catch (error) {
    process.stderr.write(
      `escrow: dropping malformed stdio line: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return { message: undefined, remaining };
  }
}

function writeMessage(message: unknown, framing: StdioFraming): void {
  const body = JSON.stringify(message);
  if (framing === 'line') {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function respondText(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { loadConfig } from './config.js';

export type HookHarness = 'codex' | 'claude';
export type HookEvent = 'session-start' | 'stop';

export interface HookRuntime {
  env: NodeJS.ProcessEnv;
  stdin: Readable;
  /** The only channel to the harness: callers must pass documented hook output here. */
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

/** Injected at SessionStart so agents actually use the memory tools. */
export const MEMORY_DISCIPLINE = [
  "Knowledge Escrow is this user's durable, local memory across sessions (MCP server `knowledge_escrow`; tools `memory_read`, `memory_write`, `memory_link`, `memory_forget`).",
  '- Before non-trivial work, call `memory_read` with a short focused query (person, topic, decision) to surface what is already known. Do not re-derive or re-ask.',
  '- After substantive work, call `memory_write` for durable learnings: decisions (with why), commitments (owner, recipient, due date), notes about people, lessons. One self-contained memory per item, real dates.',
  '- Skip trivia and anything obvious from the source material. Never store passwords, API keys, or customer personal data.'
].join('\n');

const STDIN_TIMEOUT_MS = 1500;
const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLOUT_DAY_DIRS_TO_SEARCH = 3;

/**
 * Entry point for `escrow hook <event> [--harness codex|claude]`. Harnesses
 * run hooks inline with the session, so this must never throw, never exit
 * non-zero, and never print anything but the documented hook output.
 */
export async function runHook(args: string[], runtime: HookRuntime): Promise<void> {
  try {
    const { event, harness } = parseHookArgs(args);
    if (event === 'session-start') {
      await readPayload(runtime.stdin);
      runtime.writeStdout(`${JSON.stringify(sessionStartOutput())}\n`);
      return;
    }
    if (event === 'stop') {
      const payload = await readPayload(runtime.stdin);
      await copyTranscriptToIngest(harness, payload, runtime);
      // Codex's reference Stop hook prints `{}`; Claude Code needs no output.
      if (harness === 'codex') runtime.writeStdout('{}\n');
      return;
    }
    runtime.writeStderr(`escrow hook: unknown event "${event ?? ''}"\n`);
  } catch (error) {
    runtime.writeStderr(`escrow hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export function sessionStartOutput(): { hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string } } {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: MEMORY_DISCIPLINE } };
}

function parseHookArgs(args: string[]): { event: string | undefined; harness: HookHarness } {
  const flagIndex = args.indexOf('--harness');
  const harnessValue = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const valueIndex = flagIndex >= 0 ? flagIndex + 1 : -1;
  const event = args.find((arg, index) => !arg.startsWith('--') && index !== valueIndex);
  return { event, harness: harnessValue === 'claude' ? 'claude' : 'codex' };
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
}

/** Reads the hook JSON from stdin, tolerating a TTY, empty input, bad JSON, and a stalled pipe. */
async function readPayload(stdin: Readable): Promise<HookPayload> {
  if ((stdin as Readable & { isTTY?: boolean }).isTTY) return {};
  const raw = await new Promise<string>((resolve) => {
    let data = '';
    const finish = () => {
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      // Release the handle so a stalled pipe cannot keep the process alive.
      stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.once('end', finish);
    stdin.once('error', finish);
  });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const { session_id, transcript_path } = parsed as Record<string, unknown>;
    return {
      session_id: typeof session_id === 'string' ? session_id : undefined,
      transcript_path: typeof transcript_path === 'string' ? transcript_path : undefined
    };
  } catch {
    return {};
  }
}

async function copyTranscriptToIngest(harness: HookHarness, payload: HookPayload, runtime: HookRuntime): Promise<void> {
  const config = loadConfig(runtime.env);
  const ingestRoot = path.join(config.dataDir, 'ingest');
  await pruneIngest(ingestRoot, config.ingestRetentionDays ?? DEFAULT_RETENTION_DAYS);

  const source = await locateTranscript(harness, payload, runtime.env);
  if (!source) return;
  const targetDir = path.join(ingestRoot, harness);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, path.join(targetDir, path.basename(source)));
}

async function locateTranscript(harness: HookHarness, payload: HookPayload, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const envPath = harness === 'codex' ? env['CODEX_SESSION_FILE'] : env['CLAUDE_TRANSCRIPT_PATH'];
  for (const candidate of [payload.transcript_path, envPath]) {
    if (candidate && (await isFile(candidate))) return candidate;
  }
  // Codex's hook payload carries no transcript path; its rollout file is
  // named rollout-<timestamp>-<session_id>.jsonl under CODEX_HOME/sessions.
  if (harness === 'codex' && payload.session_id && /^[A-Za-z0-9-]+$/.test(payload.session_id)) {
    return findCodexRollout(payload.session_id, env);
  }
  return undefined;
}

async function findCodexRollout(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const root = path.join(env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'), 'sessions');
  const dayDirs: string[] = [];
  for (const year of await sortedDirs(root)) {
    for (const month of await sortedDirs(year)) dayDirs.push(...(await sortedDirs(month)));
    if (dayDirs.length >= ROLLOUT_DAY_DIRS_TO_SEARCH) break;
  }
  for (const dir of dayDirs.slice(0, ROLLOUT_DAY_DIRS_TO_SEARCH)) {
    const match = (await safeReaddir(dir)).find(
      (entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${sessionId}.jsonl`)
    );
    if (match) return path.join(dir, match.name);
  }
  return undefined;
}

/** Child directories, newest-first by name (dates are zero-padded). */
async function sortedDirs(dir: string): Promise<string[]> {
  return (await safeReaddir(dir))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort()
    .reverse();
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Deletes ingest copies older than the retention window; never touches transcript sources. */
async function pruneIngest(ingestRoot: string, retentionDays: number): Promise<void> {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - days * DAY_MS;
  for (const harnessDir of await sortedDirs(ingestRoot)) {
    for (const entry of await safeReaddir(harnessDir)) {
      if (!entry.isFile()) continue;
      const file = path.join(harnessDir, entry.name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        continue;
      }
    }
  }
}

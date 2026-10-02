import type { Readable, Writable } from 'node:stream';

type StdioFraming = 'line' | 'headers';

export type StdioHttpProxyOptions = {
  endpoint: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  fetch?: typeof globalThis.fetch;
};

export async function runStdioHttpProxy(options: StdioHttpProxyOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const request = options.fetch ?? globalThis.fetch;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let framing: StdioFraming | undefined;

  for await (const chunk of stdin) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      if (!framing) {
        const preview = buffer.toString('utf8').trimStart();
        if (!preview) break;
        framing = preview.startsWith('{') ? 'line' : 'headers';
      }

      const parsed = framing === 'line' ? readLineMessage(buffer) : readHeaderMessage(buffer);
      if (!parsed) break;
      buffer = parsed.remaining;
      if (parsed.message === undefined) continue;

      const response = await forwardMessage(options.endpoint, parsed.message, request, stderr);
      if (response !== undefined) writeMessage(stdout, response, framing);
    }
  }

  if (buffer.toString('utf8').trim()) {
    throw new Error('Knowledge Escrow stdio proxy received an incomplete JSON-RPC message.');
  }
}

async function forwardMessage(
  endpoint: string,
  message: any,
  request: typeof globalThis.fetch,
  stderr: Writable
): Promise<any | undefined> {
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const body = await response.json();
    return message?.id === undefined ? undefined : body;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stderr.write(`mcp-escrow-stdio: HTTP proxy request failed: ${detail}\n`);
    if (message?.id === undefined) return undefined;
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32000,
        message: `Knowledge Escrow backend unavailable: ${detail}`
      }
    };
  }
}

function readLineMessage(
  buffer: Buffer
): { message: any | undefined; remaining: Buffer } | undefined {
  const lineEnd = buffer.indexOf('\n');
  if (lineEnd === -1) return undefined;
  const line = buffer.subarray(0, lineEnd).toString('utf8').trim();
  return {
    message: line ? JSON.parse(line) : undefined,
    remaining: buffer.subarray(lineEnd + 1)
  };
}

function readHeaderMessage(
  buffer: Buffer
): { message: any; remaining: Buffer } | undefined {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return undefined;
  const header = buffer.subarray(0, headerEnd).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) throw new Error('Missing Content-Length header');
  const contentLength = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) return undefined;
  return {
    message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')),
    remaining: buffer.subarray(bodyEnd)
  };
}

function writeMessage(stdout: Writable, message: any, framing: StdioFraming): void {
  const body = JSON.stringify(message);
  if (framing === 'line') {
    stdout.write(`${body}\n`);
    return;
  }
  stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

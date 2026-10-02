import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runStdioHttpProxy } from '../src/mcp/stdio-http-proxy.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});

async function startBackend(): Promise<{ endpoint: string; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(message);
    const response = message.id === undefined
      ? {}
      : { jsonrpc: '2.0', id: message.id, result: { echoed: message.method } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

describe('stdio-to-HTTP proxy', () => {
  it('forwards newline-delimited requests and suppresses notification responses', async () => {
    const backend = await startBackend();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    const run = runStdioHttpProxy({ endpoint: backend.endpoint, stdin, stdout, stderr });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    stdin.end();
    await run;

    expect(backend.requests).toHaveLength(2);
    expect(output.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output).result.echoed).toBe('initialize');
  });

  it('preserves Content-Length framing', async () => {
    const backend = await startBackend();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = '';
    stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });

    const run = runStdioHttpProxy({ endpoint: backend.endpoint, stdin, stdout });
    stdin.end(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    await run;

    expect(output).toMatch(/^Content-Length: \d+\r\n\r\n/);
    const body = output.slice(output.indexOf('\r\n\r\n') + 4);
    expect(JSON.parse(body)).toMatchObject({ id: 7, result: { echoed: 'tools/list' } });
  });

  it('returns a JSON-RPC error without closing the transport when the backend is unavailable', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    const run = runStdioHttpProxy({
      endpoint: 'http://127.0.0.1:1/mcp',
      stdin,
      stdout,
      stderr
    });
    stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })}\n`);
    await run;

    expect(JSON.parse(output)).toMatchObject({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32000 }
    });
  });
});

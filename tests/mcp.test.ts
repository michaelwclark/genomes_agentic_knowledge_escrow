import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleJsonRpc, MemoryRouter, type BrainConfig } from '../src/index.js';
import { startStdioServer } from '../src/mcp/server.js';

function testConfig(dataDir: string): BrainConfig {
  return {
    dataDir,
    hotMemoryDirs: [],
    hotMemoryHours: 72,
    grepRoots: [],
    enableWrites: true,
    metricsEnabled: true,
    metricsRetentionDays: 30,
    backupRetentionCount: 5,
    ledgerRetentionDays: 90,
    healthFreshnessMinutes: 1440,
    httpHost: '127.0.0.1',
    httpPort: 0,
    redactionEnabled: true,
    redactionPatterns: [],
    embeddingProvider: 'none',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'nomic-embed-text',
    projectRoots: {}
  };
}

describe('MCP JSON-RPC handler', () => {
  it('lists and calls memory tools', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-mcp-'));
    const router = new MemoryRouter(testConfig(dir));

    try {
      const tools = await handleJsonRpc(router, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });
      const toolNames = ((tools as any).result.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(toolNames).toContain('memory_read');
      expect(toolNames).toContain('memory_analytics');
      expect(toolNames).toContain('memory_health');

      const write = await handleJsonRpc(router, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'memory_write',
          arguments: { content: 'A non-obvious lesson from an install smoke test.' }
        }
      });
      expect((write as any).result.content[0].text).toContain('CROSS_FEATURE_LEARNING');

      const analytics = await handleJsonRpc(router, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_analytics', arguments: { hours: 24 } }
      });
      expect((analytics as any).result.content[0].text).toContain('readHitRate');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('stdio bridge lifecycle', () => {
  it('exits cleanly when stdin closes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    const stdin = new PassThrough();
    try {
      startStdioServer(router, { stdin, exit: (code) => exits.push(code) });
      stdin.end();
      await waitFor(() => exits.length > 0);
      // 'end' and 'close' both fire; the shutdown guard must exit exactly once.
      expect(exits).toEqual([0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists an in-flight memory_write before exiting on immediate stdin EOF', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-eof-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    const stdin = new PassThrough();
    try {
      startStdioServer(router, { stdin, exit: (code) => exits.push(code) });
      const writeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_write', arguments: { content: 'EOF-proof durable memory write.' } }
      };
      // No trailing newline: a client that writes its last request and
      // closes stdin in the same breath never terminates the final line.
      stdin.write(JSON.stringify(writeRequest));
      stdin.end();
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);

      const ledger = await readFile(path.join(dir, 'memory_ops.jsonl'), 'utf8');
      expect(ledger).toContain('EOF-proof durable memory write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes the response to stdout before exiting, for a newline-terminated request + EOF', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-eof-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    const stdin = new PassThrough();
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      writes.push(String(chunk));
      const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      startStdioServer(router, { stdin, exit: (code) => exits.push(code) });
      const writeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_write', arguments: { content: 'Newline-terminated EOF-proof write.' } }
      };
      stdin.write(`${JSON.stringify(writeRequest)}\n`);
      stdin.end();
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
      // The response for id:1 must already be on stdout by the time exit()
      // is invoked — asserted here, after waitFor resolves on the exit call
      // itself, so this checks state at/before exit, not merely eventually.
      expect(writes.some((line) => line.includes('"id":1') && line.includes('"jsonrpc"'))).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not wedge on a malformed line; a later write on the same connection still persists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-eof-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    const stdin = new PassThrough();
    try {
      startStdioServer(router, { stdin, exit: (code) => exits.push(code) });
      const writeRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_write', arguments: { content: 'Write after a malformed line.' } }
      };
      stdin.write('{this is not valid json\n');
      stdin.write(`${JSON.stringify(writeRequest)}\n`);
      stdin.end();
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);

      const ledger = await readFile(path.join(dir, 'memory_ops.jsonl'), 'utf8');
      expect(ledger).toContain('Write after a malformed line');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits when the parent dies without closing stdin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    let parentPid = 4242;
    try {
      startStdioServer(router, {
        stdin: new PassThrough(),
        exit: (code) => exits.push(code),
        getParentPid: () => parentPid,
        parentCheckIntervalMs: 20
      });
      parentPid = 1;
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits when a newer build lands on disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    let buildMtimeMs: number | undefined = 1000;
    try {
      startStdioServer(router, {
        stdin: new PassThrough(),
        exit: (code) => exits.push(code),
        getBuildMtimeMs: () => buildMtimeMs,
        parentCheckIntervalMs: 20
      });
      buildMtimeMs = 2000;
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stays alive while the entry script is transiently missing mid-rebuild', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-stdio-'));
    const router = new MemoryRouter(testConfig(dir));
    const exits: number[] = [];
    let buildMtimeMs: number | undefined = 1000;
    try {
      startStdioServer(router, {
        stdin: new PassThrough(),
        exit: (code) => exits.push(code),
        getBuildMtimeMs: () => buildMtimeMs,
        parentCheckIntervalMs: 20
      });
      buildMtimeMs = undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(exits).toEqual([]);
      buildMtimeMs = 2000;
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

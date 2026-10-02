import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, type BrainConfig } from '../src/index.js';
import { startHttpServer } from '../src/mcp/server.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});

describe('HTTP observability', () => {
  it('serves health, readiness, analytics, and Prometheus metrics', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-http-'));
    const config: BrainConfig = {
      dataDir,
      projectRoots: {},
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
      ollamaModel: 'nomic-embed-text'
    };
    const router = new MemoryRouter(config);
    const server = startHttpServer(router, config.httpHost, config.httpPort);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const base = `http://127.0.0.1:${address.port}`;
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await router.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    await router.write({ content: 'Project rule: HTTP observability must be verifiable.' });
    await router.read({ query: 'HTTP observability' });

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect((await health.json()).service).toBe('knowledge-escrow');

    const readiness = await fetch(`${base}/readyz`);
    expect(readiness.status).toBe(200);
    expect((await readiness.json()).status).toBe('healthy');

    const analytics = await fetch(`${base}/analytics?hours=1`);
    const summary = await analytics.json();
    expect(summary.operations).toBe(2);
    expect(summary.readHitRate).toBe(1);

    const metrics = await fetch(`${base}/metrics?hours=1`);
    const text = await metrics.text();
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('knowledge_escrow_operations_total 2');
  });
});

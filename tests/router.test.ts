import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifyMemory, contentHash, MemoryRouter, MetricsStore, type BrainConfig } from '../src/index.js';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createEmbeddingProvider } from '../src/embedding.js';
import { sanitizePostgresText } from '../src/store/postgres-document-store.js';

function testConfig(overrides: Partial<BrainConfig> & { dataDir: string }): BrainConfig {
  return {
    dataDir: overrides.dataDir,
    projectRoot: overrides.projectRoot,
    projectRoots: overrides.projectRoots ?? {},
    userMemoryRoot: overrides.userMemoryRoot,
    hotMemoryDirs: overrides.hotMemoryDirs ?? [],
    hotMemoryHours: overrides.hotMemoryHours ?? 72,
    grepRoots: overrides.grepRoots ?? [],
    enableWrites: overrides.enableWrites ?? true,
    metricsEnabled: overrides.metricsEnabled ?? true,
    metricsRetentionDays: overrides.metricsRetentionDays ?? 30,
    backupRetentionCount: overrides.backupRetentionCount ?? 5,
    ledgerRetentionDays: overrides.ledgerRetentionDays ?? 90,
    healthFreshnessMinutes: overrides.healthFreshnessMinutes ?? 1440,
    httpHost: overrides.httpHost ?? '127.0.0.1',
    httpPort: overrides.httpPort ?? 0,
    postgresUrl: overrides.postgresUrl,
    sqlitePath: overrides.sqlitePath,
    redactionEnabled: overrides.redactionEnabled ?? true,
    redactionPatterns: overrides.redactionPatterns ?? [],
    embeddingProvider: overrides.embeddingProvider ?? 'none',
    ollamaUrl: overrides.ollamaUrl ?? 'http://127.0.0.1:11434',
    ollamaModel: overrides.ollamaModel ?? 'nomic-embed-text'
  };
}

async function tempRouter() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-test-'));
  const router = new MemoryRouter(testConfig({ dataDir: dir }));
  return { dir, router };
}

describe('memory router', () => {
  it('normalizes hashes for dedupe', () => {
    expect(contentHash('Remember  this')).toBe(contentHash(' remember this '));
  });

  it('classifies user preferences', () => {
    const result = classifyMemory('User prefers concise status reports for long-running work.');
    expect(result.kind).toBe('USER_PREF');
    expect(result.substrates).toContain('user_memory');
  });

  it('bulk import dedupes silently and re-runs do not grow the ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-test-'));
    const router = new MemoryRouter(testConfig({ dataDir: dir }));
    try {
      const records = [
        { content: 'Imported fact one about backup recovery.' },
        { content: 'Imported fact two about retry replay.' },
        { content: 'Imported fact one about backup recovery.' }
      ];
      const first = await router.getStore().importRecords(records);
      expect(first).toEqual({ imported: 2, skipped: 1 });

      const ledgerAfterFirst = await readFile(path.join(dir, 'memory_ops.jsonl'), 'utf8');
      const linesAfterFirst = ledgerAfterFirst.split('\n').filter(Boolean).length;
      expect(linesAfterFirst).toBe(2);

      const second = await router.getStore().importRecords(records);
      expect(second).toEqual({ imported: 0, skipped: 3 });
      const ledgerAfterSecond = await readFile(path.join(dir, 'memory_ops.jsonl'), 'utf8');
      expect(ledgerAfterSecond.split('\n').filter(Boolean).length).toBe(linesAfterFirst);

      const read = await router.read({ query: 'retry replay' });
      expect(read.hits.some((hit) => hit.substrate === 'jsonl')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes project memory through the project-roots registry', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-test-'));
    const acmeDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-acme-'));
    const widgetDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-widget-'));
    const router = new MemoryRouter(
      testConfig({
        dataDir: dir,
        projectRoots: { acme: acmeDir, widget_co: widgetDir }
      })
    );
    try {
      await router.write({
        content: 'Project rule: acme memory writes land in the registry root.',
        scope: { project: 'acme' },
        kindHint: 'PROJECT_RULE'
      });
      const acmeMemory = await readFile(path.join(acmeDir, 'MEMORY.md'), 'utf8');
      expect(acmeMemory).toContain('registry root');

      await router.write({
        content: 'Project rule: dashed project names match underscore registry keys.',
        scope: { project: 'widget-co' },
        kindHint: 'PROJECT_RULE'
      });
      const widgetMemory = await readFile(path.join(widgetDir, 'MEMORY.md'), 'utf8');
      expect(widgetMemory).toContain('underscore registry keys');

      const read = await router.read({ query: 'registry root', project: 'acme' });
      expect(read.hits.some((hit) => hit.substrate === 'project_memory')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(acmeDir, { recursive: true, force: true });
      await rm(widgetDir, { recursive: true, force: true });
    }
  });

  it('writes, dedupes, reads, links, and forgets', async () => {
    const { dir, router } = await tempRouter();
    try {
      const first = await router.write({
        content: 'Project rule: always dry-run imports before touching existing memory.',
        scope: { project: 'escrow' },
        kindHint: 'PROJECT_RULE'
      });
      const duplicate = await router.write({
        content: 'Project rule: always dry-run imports before touching existing memory.',
        scope: { project: 'escrow' },
        kindHint: 'PROJECT_RULE'
      });
      expect(first.deduped).toBe(false);
      expect(duplicate.deduped).toBe(true);

      const read = await router.read({ query: 'dry-run imports', project: 'escrow' });
      expect(read.count).toBe(1);
      expect(read.hits[0]?.preview).toContain('dry-run imports');

      const link = await router.link({
        fromOpId: first.recordId,
        toOpId: duplicate.recordId,
        relation: 'duplicates'
      });
      expect(link.linkId).toBeTruthy();

      const forget = await router.forget({ opId: first.recordId });
      expect(forget.tombstoned).toBe(1);
      const afterForget = await router.read({ query: 'dry-run imports', project: 'escrow' });
      expect(afterForget.count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records privacy-safe analytics and produces a health report', async () => {
    const { dir, router } = await tempRouter();
    try {
      await router.write({ content: 'Project rule: metrics never store memory content.', kindHint: 'PROJECT_RULE' });
      await router.write({ content: 'Project rule: metrics never store memory content.', kindHint: 'PROJECT_RULE' });
      await router.read({ query: 'metrics never store memory content' });
      await router.read({ query: 'definitely absent retrieval token' });

      const analytics = await router.analytics(24);
      expect(analytics.source).toBe('local');
      expect(analytics.operations).toBe(4);
      expect(analytics.reads).toBe(2);
      expect(analytics.readsWithHits).toBe(1);
      expect(analytics.dedupedWrites).toBe(1);
      expect(analytics.methods.read.count).toBe(2);

      const rawMetrics = await readFile(path.join(dir, 'metrics.jsonl'), 'utf8');
      expect(rawMetrics).not.toContain('metrics never store memory content');
      expect(rawMetrics).not.toContain('definitely absent retrieval token');

      const health = await router.healthReport(false);
      expect(health.ok).toBe(true);
      expect(health.status).toBe('healthy');
      expect(health.metrics.eventCount).toBe(4);
      expect(health.store.activeRecords).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prunes local operation metrics without touching memory records', async () => {
    const { dir, router } = await tempRouter();
    try {
      await router.read({ query: 'retention smoke' });
      const result = await router.pruneMetrics(60);
      expect(result.days).toBe(60);
      expect(result.local.kept).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('automatically prunes operation metrics outside the retention window', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-metrics-retention-'));
    const metrics = new MetricsStore(dir, true, 1);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'metrics.jsonl'),
        `${JSON.stringify({
          id: 'old-event',
          createdAt: '2020-01-01T00:00:00.000Z',
          method: 'read',
          durationMs: 1,
          ok: true,
          resultCount: 1
        })}\n`,
        'utf8'
      );
      await metrics.record({ method: 'read', durationMs: 2, ok: true, resultCount: 1 });
      const recent = await metrics.recent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]?.id).not.toBe('old-event');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes optional adapter handles for finite CLI commands', async () => {
    const { dir, router } = await tempRouter();
    const postgresClose = vi.fn(async () => undefined);
    try {
      (router as any).postgresDocuments = { close: postgresClose };
      await router.close();
      expect(postgresClose).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes project memories into a project MEMORY.md when scoped', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-data-'));
    const osRoot = await mkdtemp(path.join(os.tmpdir(), 'escrow-root-'));
    const projectRoot = path.join(osRoot, '02-projects', 'acme-app');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'MEMORY.md'), '# Memory Policy\n', 'utf8');
    const router = new MemoryRouter(testConfig({
      dataDir,
      projectRoot: osRoot,
      enableWrites: true
    }));

    try {
      const result = await router.write({
        content: 'Project rule: scoped project memories land in the project memory file.',
        scope: { project: 'acme-app' }
      });

      expect(result.writes).toContainEqual({
        substrate: 'project_memory',
        path: path.join(projectRoot, 'MEMORY.md')
      });
      const memory = await readFile(path.join(projectRoot, 'MEMORY.md'), 'utf8');
      expect(memory).toContain('scoped project memories land in the project memory file');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(osRoot, { recursive: true, force: true });
    }
  });

  it('writes and reads user, feature, and agent trace file layers', async () => {
    const { dir, router } = await tempRouter();
    try {
      const user = await router.write({
        content: 'User prefers direct status summaries with exact layer evidence.',
        scope: { project: 'escrow' },
        kindHint: 'USER_PREF'
      });
      const feature = await router.write({
        content: 'Feature 47 status: hot memory replay validates recent conversations.',
        scope: { project: 'escrow', feature: 47 },
        kindHint: 'FEATURE_STATE'
      });
      const trace = await router.write({
        content: 'Agent trace: smoke test ran the grep and hot memory layers.',
        scope: { project: 'escrow' },
        kindHint: 'AGENT_TRACE'
      });

      expect(user.writes.some((write) => write.substrate === 'user_memory')).toBe(true);
      expect(feature.writes.some((write) => write.substrate === 'feature_worklog')).toBe(true);
      expect(trace.writes.some((write) => write.substrate === 'agent_trace')).toBe(true);

      const read = await router.read({ query: 'hot memory replay', project: 'escrow', limit: 10 });
      const substrates = read.hits.map((hit) => hit.substrate);
      expect(substrates).toContain('jsonl');
      expect(substrates).toContain('feature_worklog');
      expect(read.hits.map((hit) => hit.preview).join('\n')).toContain('hot memory replay');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads exact-match grep sidecar files', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-data-'));
    const grepRoot = await mkdtemp(path.join(os.tmpdir(), 'escrow-grep-'));
    try {
      await mkdir(path.join(grepRoot, 'docs'), { recursive: true });
      await writeFile(
        path.join(grepRoot, 'docs', 'layers.md'),
        'The grep sidecar layer catches exact setup notes before semantic retrieval warms up.',
        'utf8'
      );
      const router = new MemoryRouter(testConfig({ dataDir, grepRoots: [grepRoot] }));
      const read = await router.read({ query: 'exact setup notes', limit: 5 });
      expect(read.hits.some((hit) => hit.substrate === 'grep_sidecar')).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(grepRoot, { recursive: true, force: true });
    }
  });

  it('reads recent conversation JSONL through the hot memory layer', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'escrow-data-'));
    const hotRoot = await mkdtemp(path.join(os.tmpdir(), 'escrow-hot-'));
    try {
      await writeFile(
        path.join(hotRoot, 'session.jsonl'),
        `${JSON.stringify({ type: 'message', content: 'Recent memory says 72 hour hot cache should answer active project context.' })}\n`,
        'utf8'
      );
      const router = new MemoryRouter(testConfig({ dataDir, hotMemoryDirs: [hotRoot], hotMemoryHours: 72 }));
      const read = await router.read({ query: '72 hour hot cache', project: 'escrow', limit: 5 });
      expect(read.hits.some((hit) => hit.substrate === 'hot_memory')).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(hotRoot, { recursive: true, force: true });
    }
  });

  it('loads local .env values without overriding existing environment', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-env-'));
    const env: NodeJS.ProcessEnv = { KNOWLEDGE_ESCROW_HTTP_PORT: '4999' };
    try {
      const file = path.join(dir, '.env');
      await writeFile(
        file,
        [
          'KNOWLEDGE_ESCROW_DATA_DIR=.escrow-from-env',
          'KNOWLEDGE_ESCROW_HTTP_PORT=3155',
          'KNOWLEDGE_ESCROW_ENABLE_WRITES=0'
        ].join('\n'),
        'utf8'
      );

      loadDotEnv(file, env);
      const config = loadConfig(env);

      expect(config.dataDir).toBe('.escrow-from-env');
      expect(config.httpPort).toBe(4999);
      expect(config.enableWrites).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults redaction to off', () => {
    expect(loadConfig({}).redactionEnabled).toBe(false);
  });

  it('keeps redaction off for any value other than "1"', () => {
    expect(loadConfig({ KNOWLEDGE_ESCROW_REDACTION: '0' }).redactionEnabled).toBe(false);
    expect(loadConfig({ KNOWLEDGE_ESCROW_REDACTION: 'true' }).redactionEnabled).toBe(false);
  });

  it('enables redaction when KNOWLEDGE_ESCROW_REDACTION=1', () => {
    expect(loadConfig({ KNOWLEDGE_ESCROW_REDACTION: '1' }).redactionEnabled).toBe(true);
  });

  it('falls back to the legacy GENOMES_BRAIN_* name when the new one is unset', () => {
    expect(loadConfig({ GENOMES_BRAIN_REDACTION: '1' }).redactionEnabled).toBe(true);
    expect(loadConfig({ GENOMES_BRAIN_DATA_DIR: '/tmp/legacy-data' }).dataDir).toBe('/tmp/legacy-data');
    // The new name wins when both are set.
    expect(
      loadConfig({ KNOWLEDGE_ESCROW_DATA_DIR: '/tmp/new-data', GENOMES_BRAIN_DATA_DIR: '/tmp/legacy-data' }).dataDir
    ).toBe('/tmp/new-data');
  });

  it('defaults the MCP server name and honors an override', () => {
    expect(loadConfig({}).serverName).toBeUndefined();
    expect(loadConfig({ KNOWLEDGE_ESCROW_SERVER_NAME: 'knowledge-escrow' }).serverName).toBe('knowledge-escrow');
  });

  it('loads Ollama embedding configuration for pgvector', () => {
    const config = loadConfig({
      KNOWLEDGE_ESCROW_EMBEDDING_PROVIDER: 'ollama',
      KNOWLEDGE_ESCROW_OLLAMA_URL: 'http://127.0.0.1:11434',
      KNOWLEDGE_ESCROW_OLLAMA_MODEL: 'nomic-embed-text'
    });

    expect(config.embeddingProvider).toBe('ollama');
    expect(config.ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(config.ollamaModel).toBe('nomic-embed-text');
  });

  it('bounds Ollama embedding input before sending the request', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      expect(body.prompt?.length).toBe(2000);
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = createEmbeddingProvider({
        provider: 'ollama',
        ollamaUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'nomic-embed-text'
      });
      await expect(provider.embed('x'.repeat(3000))).resolves.toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('strips NUL bytes before Postgres text writes', () => {
    expect(sanitizePostgresText('record\u0000value')).toBe('recordvalue');
  });

  it('uses pgvector as the primary read path when embeddings are configured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-pgvector-primary-'));
    const fileRead = vi.fn(async () => []);
    const router = new MemoryRouter(
      testConfig({
        dataDir: dir,
        postgresUrl: 'postgres://example/escrow',
        embeddingProvider: 'deterministic'
      }),
      { read: fileRead } as any
    );
    const search = vi.fn(async () => [{
      substrate: 'pgvector',
      id: 'pgvector-hit',
      path: 'postgres://memory_documents/pgvector-hit',
      title: 'Semantic hit',
      confidence: 0.91,
      scope: {},
      content: 'A semantic hit from pgvector.'
    }]);
    (router as any).postgresDocuments = { search };

    try {
      const result = await router.read({ query: 'semantic recall', limit: 8 });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.substrate).toBe('pgvector');
      expect(search).toHaveBeenCalledOnce();
      expect(fileRead).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exposes active records for resumable pgvector backfill', async () => {
    const { dir, router } = await tempRouter();
    try {
      await router.write({
        content: 'Project rule: pgvector backfill can replay existing JSONL records.',
        scope: { project: 'escrow' },
        kindHint: 'PROJECT_RULE'
      });

      const records = await router.getStore().activeRecordsForBackfill();
      expect(records).toHaveLength(1);
      expect(records[0]?.content).toContain('pgvector backfill');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wires the sqlite layer into write, read, forget, and health', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-sqlite-router-'));
    const sqlitePath = path.join(dir, 'escrow.sqlite');
    const router = new MemoryRouter(testConfig({ dataDir: dir, sqlitePath }));
    try {
      const written = await router.write({
        content: 'Decision: vendor Acme chosen for SSO integration across the platform.',
        kindHint: 'FACT'
      });
      expect(written.writes.some((write) => write.substrate === 'sqlite')).toBe(true);

      const read = await router.read({ query: 'SSO vendor Acme' });
      expect(read.hits.some((hit) => hit.substrate === 'sqlite')).toBe(true);

      const sqlite = router.getSqliteDocumentStore();
      expect(await sqlite?.countDocuments()).toBe(1);

      await router.forget({ opId: written.recordId });
      expect(await sqlite?.countDocuments()).toBe(0);

      const health = router.layerHealth();
      expect(health.find((layer) => layer.id === 'sqlite')?.status).toBe('ok');
    } finally {
      await router.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts a sensitive value before it reaches the ledger, and redacts it again on read', async () => {
    const { dir, router } = await tempRouter();
    try {
      const written = await router.write({
        content: 'Customer SSN 123-45-6789 on the account application.',
        kindHint: 'FACT'
      });
      expect(written.warnings.some((warning) => warning.includes('redacted'))).toBe(true);

      const ledgerRaw = await readFile(path.join(dir, 'memory_ops.jsonl'), 'utf8');
      expect(ledgerRaw).not.toContain('123-45-6789');
      expect(ledgerRaw).toContain('[REDACTED:ssn]');

      const read = await router.read({ query: 'account application' });
      const preview = read.hits.find((hit) => hit.substrate === 'jsonl')?.preview ?? '';
      expect(preview).not.toContain('123-45-6789');
      expect(preview).toContain('[REDACTED:ssn]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

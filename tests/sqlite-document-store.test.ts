import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDocumentStore, sanitizeFtsQuery } from '../src/store/sqlite-document-store.js';
import type { MemoryRecord } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});

function record(content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: randomUUID(),
    op: 'write',
    content,
    contentHash: undefined,
    kind: 'FACT',
    title: overrides.title ?? 'Test memory',
    scope: overrides.scope ?? { project: 'test' },
    substrates: ['sqlite'],
    status: 'committed',
    deduped: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

async function tempStore(provider: 'none' | 'deterministic' = 'none') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-sqlite-'));
  const dbPath = path.join(dir, 'escrow.sqlite');
  const store = new SqliteDocumentStore(dbPath, {
    embeddingProvider: provider,
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'nomic-embed-text'
  });
  cleanup.push(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, store };
}

describe('SqliteDocumentStore', () => {
  it('finds a document via FTS5 hit', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('The vendor Acme was chosen for SSO integration.', { title: 'SSO decision' }));
    await store.upsertMemory(record('Unrelated note about lunch plans.', { title: 'Lunch' }));

    const hits = await store.search('SSO vendor', 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.substrate).toBe('sqlite');
    expect(hits[0]?.content).toContain('Acme');
  });

  it('sanitizes punctuation-heavy queries into a safe MATCH expression', () => {
    expect(sanitizeFtsQuery('SSO!! vendor??? "quoted"')).toBe('"SSO" OR "vendor" OR "quoted"');
    expect(sanitizeFtsQuery('***')).toBe('');
  });

  it('does not throw on an all-punctuation query', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('Some content here.'));
    await expect(store.search('***', 5)).resolves.toEqual([]);
  });

  it('fuses lexical and vector ranking when the deterministic provider is active', async () => {
    const { store } = await tempStore('deterministic');
    await store.upsertMemory(record('Decision: vendor Acme chosen for SSO integration across the platform.', { title: 'SSO decision' }));
    await store.upsertMemory(record('Completely different topic about quarterly budget planning.', { title: 'Budget' }));

    const hits = await store.search('SSO vendor Acme', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toBe('SSO decision');
    for (const hit of hits) {
      expect(hit.confidence).toBeGreaterThan(0);
      expect(hit.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('filters search results by project', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('Shared keyword alpha in project one.', { scope: { project: 'proj-one' } }));
    await store.upsertMemory(record('Shared keyword alpha in project two.', { scope: { project: 'proj-two' } }));

    const hits = await store.search('alpha', 10, 'proj-one');
    expect(hits.length).toBe(1);
    expect(hits[0]?.scope.project).toBe('proj-one');
  });

  it('forget removes the row by external id', async () => {
    const { store } = await tempStore();
    const seeded = record('Forget-me content about rotation policy.');
    await store.upsertMemory(seeded);
    expect(await store.countDocuments()).toBe(1);

    const removed = await store.delete({ opId: seeded.id });
    expect(removed).toBe(1);
    expect(await store.countDocuments()).toBe(0);
    await expect(store.search('rotation policy', 5)).resolves.toEqual([]);
  });

  it('reindex rebuilds the store from a ledger record set', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('Stale content that reindex should remove.'));
    expect(await store.countDocuments()).toBe(1);

    const freshRecords = [
      record('Fresh content one about release notes.'),
      record('Fresh content two about release notes.')
    ];
    const result = await store.reindex(freshRecords);
    expect(result).toEqual({ upserted: 2, skipped: 0 });
    expect(await store.countDocuments()).toBe(2);

    const hits = await store.search('release notes', 10);
    expect(hits.length).toBe(2);
  });

  it('skips empty content on upsert', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('   '));
    expect(await store.countDocuments()).toBe(0);
  });

  it('health reports ok with a document count', async () => {
    const { store } = await tempStore();
    await store.upsertMemory(record('Health check content.'));
    const health = await store.health();
    expect(health.status).toBe('ok');
    expect(health.detail).toContain('1 document');
  });
});

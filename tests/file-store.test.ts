import { randomUUID } from 'node:crypto';
import fs, { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileMemoryStore } from '../src/store/file-store.js';
import { contentHash } from '../src/hash.js';
import type { MemoryClassification, MemoryRecord } from '../src/types.js';

function classification(): MemoryClassification {
  return {
    kind: 'FACT',
    title: 'Test fact',
    scope: { project: 'test' },
    substrates: ['jsonl'],
    confidence: 0.9
  };
}

function ledgerRecord(content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: randomUUID(),
    op: 'write',
    content,
    contentHash: contentHash(content),
    kind: 'FACT',
    title: 'Seed',
    scope: { project: 'test' },
    substrates: ['jsonl'],
    status: 'committed',
    deduped: false,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function ledgerLine(content: string, overrides: Partial<MemoryRecord> = {}): string {
  return JSON.stringify(ledgerRecord(content, overrides));
}

/** Mirror of the 2026-08-25 production corruption: a write row torn mid-way
 * through its content string by a partial append, leaving no trailing newline. */
function truncatedLine(): string {
  const full = ledgerLine(
    'Project learning: a long enough content body that slicing the serialized row lands inside the JSON string value rather than the envelope.'
  );
  return full.slice(0, 120);
}

async function seededStore(ledger: string): Promise<{ dir: string; store: FileMemoryStore; opsPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-file-store-'));
  const opsPath = path.join(dir, 'memory_ops.jsonl');
  await writeFile(opsPath, ledger);
  return { dir, store: new FileMemoryStore(dir), opsPath };
}

describe('file store ledger corruption resilience', () => {
  it('writes through a ledger whose tail is truncated mid-string', async () => {
    const seed = ledgerLine('seed record one');
    const torn = truncatedLine();
    const { store, opsPath } = await seededStore(`${seed}\n${torn}`);

    const { record, deduped } = await store.write('fresh content after corruption', classification(), true);
    expect(deduped).toBe(false);
    expect(record.status).toBe('committed');

    // The new row must start on its own line — never merged into the torn tail —
    // and the torn bytes must be preserved on disk, not rewritten away.
    const raw = await readFile(opsPath, 'utf8');
    expect(raw).toContain(`${torn}\n`);
    const lines = raw.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '';
    expect((JSON.parse(lastLine) as MemoryRecord).id).toBe(record.id);
    const unparseable = lines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    expect(unparseable).toEqual([torn]);
  });

  it('read and stats skip corrupt lines and report the count', async () => {
    const seed = ledgerLine('durable seed fact');
    const { store } = await seededStore(`${seed}\n${truncatedLine()}\n${ledgerLine('second seed fact')}\n`);

    const stats = await store.stats();
    expect(stats.corruptLines).toBe(1);
    expect(stats.records).toBe(2);
    expect(stats.activeRecords).toBe(2);

    const hits = await store.read({ query: 'durable seed fact' });
    expect(hits.some((hit) => hit.content === 'durable seed fact')).toBe(true);
  });

  it('still dedupes by content hash with corruption present', async () => {
    const { store } = await seededStore(truncatedLine());
    const first = await store.write('repeatable content', classification(), true);
    const second = await store.write('repeatable content', classification(), true);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
  });

  it('reports zero corrupt lines and adds no blank lines on a clean ledger', async () => {
    const { store, opsPath } = await seededStore(`${ledgerLine('clean seed')}\n`);
    await store.write('appended to clean ledger', classification(), true);
    const stats = await store.stats();
    expect(stats.corruptLines).toBe(0);
    const raw = await readFile(opsPath, 'utf8');
    expect(raw).not.toContain('\n\n');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('recovers from a failed append by truncating back to the last known-good size, then writes cleanly', async () => {
    const { store, opsPath } = await seededStore(`${ledgerLine('seed before failure')}\n`);
    const sizeBefore = (await stat(opsPath)).size;

    // 2026-08-25: ENOSPC mid-append landed a partial fragment and every
    // subsequent read/write choked on it. Simulate the same failure mode.
    const appendSpy = vi
      .spyOn(fs, 'appendFile')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device, write'));

    await expect(store.write('this append will fail', classification(), true)).rejects.toThrow('ENOSPC');
    appendSpy.mockRestore();

    // No torn fragment left behind — the ledger is exactly as it was before the attempt.
    expect((await stat(opsPath)).size).toBe(sizeBefore);
    const rawAfterFailure = await readFile(opsPath, 'utf8');
    expect(rawAfterFailure.split('\n').filter(Boolean)).toHaveLength(1);

    // A subsequent write must succeed cleanly, proving the failed append never poisoned the ledger.
    const { record, deduped } = await store.write('recovered write after failure', classification(), true);
    expect(deduped).toBe(false);
    const stats = await store.stats();
    expect(stats.corruptLines).toBe(0);
    expect(stats.records).toBe(2);
    expect(stats.activeRecords).toBe(2);
    expect(record.status).toBe('committed');
  });
});

describe('file store backup retention', () => {
  it('prunes the default rotation dir to the newest N timestamped backups after each backup()', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-file-store-backup-'));
    const opsPath = path.join(dir, 'memory_ops.jsonl');
    await writeFile(opsPath, `${ledgerLine('seed')}\n`);

    const backupsRoot = path.join(dir, 'backups');
    const oldStamps = [
      '2020-01-01T00-00-00-000Z',
      '2020-01-02T00-00-00-000Z',
      '2020-01-03T00-00-00-000Z',
      '2020-01-04T00-00-00-000Z'
    ];
    for (const stamp of oldStamps) {
      const stampDir = path.join(backupsRoot, stamp);
      await mkdir(stampDir, { recursive: true });
      await writeFile(path.join(stampDir, 'memory_ops.jsonl'), 'old backup content\n');
    }

    const store = new FileMemoryStore(dir, 2);
    await store.backup();

    const remaining = (await readdir(backupsRoot)).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(oldStamps[0]);
    expect(remaining).not.toContain(oldStamps[1]);
    expect(remaining).not.toContain(oldStamps[2]);
    expect(remaining).toContain(oldStamps[3]);
  });

  it('does not prune a caller-supplied target directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-file-store-backup-target-'));
    const opsPath = path.join(dir, 'memory_ops.jsonl');
    await writeFile(opsPath, `${ledgerLine('seed')}\n`);

    const store = new FileMemoryStore(dir, 5);
    const customTarget = path.join(dir, 'custom-snapshot');
    await store.backup(customTarget);

    const exists = await stat(path.join(customTarget, 'memory_ops.jsonl')).then(
      () => true,
      () => false
    );
    expect(exists).toBe(true);
    // A custom target must never be swept by the default-rotation prune.
    const rootExists = await stat(path.join(dir, 'backups')).then(
      () => true,
      () => false
    );
    expect(rootExists).toBe(false);
  });
});

describe('file store ledger retention', () => {
  it('compacts dedupe-skip markers and forgotten write/forget pairs older than the cutoff', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'escrow-file-store-prune-'));
    const opsPath = path.join(dir, 'memory_ops.jsonl');

    const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recentDate = new Date().toISOString();

    const activeOld = ledgerRecord('active old content that is still live', { createdAt: oldDate });
    const forgottenOriginal = ledgerRecord('long forgotten content', {
      createdAt: oldDate,
      status: 'tombstoned'
    });
    const forgetMarker: MemoryRecord = {
      id: randomUUID(),
      op: 'forget',
      contentHash: forgottenOriginal.contentHash,
      scope: {},
      substrates: ['jsonl'],
      status: 'tombstoned',
      provenance: { targetId: forgottenOriginal.id },
      createdAt: oldDate
    };
    const skipDup = ledgerRecord('duplicate content', { status: 'skipped-dup', createdAt: oldDate });
    const recentActive = ledgerRecord('recent content still within retention', { createdAt: recentDate });

    const lines = [activeOld, forgottenOriginal, forgetMarker, skipDup, recentActive].map((r) => JSON.stringify(r));
    await writeFile(opsPath, `${lines.join('\n')}\n`);

    const store = new FileMemoryStore(dir);
    const result = await store.prune(90);

    expect(result.removed).toBe(3);
    expect(result.kept).toBe(2);

    const stats = await store.stats();
    expect(stats.corruptLines).toBe(0);
    expect(stats.records).toBe(2);
    expect(stats.activeRecords).toBe(2);

    const hits = await store.read({ query: 'active old content' });
    expect(hits.some((hit) => hit.content === activeOld.content)).toBe(true);
  });

  it('never touches active writes or rows newer than the cutoff', async () => {
    const { store, opsPath } = await seededStore(`${ledgerLine('kept because it is active and recent')}\n`);
    const result = await store.prune(90);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    const raw = await readFile(opsPath, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

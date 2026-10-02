import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentHash } from '../hash.js';
import { scoreRecord } from './scoring.js';
import type {
  ForgetInput,
  LinkInput,
  MemoryClassification,
  MemoryHit,
  MemoryReadInput,
  MemoryRecord,
  MemoryScope
} from '../types.js';

interface StoreCache {
  /** Every ledger row, in append order. */
  records: MemoryRecord[];
  /** Non-tombstoned write rows keyed by content hash — O(1) dedupe. */
  activeByHash: Map<string, MemoryRecord>;
  tombstonedIds: Set<string>;
  tombstonedHashes: Set<string>;
  /** Byte size of the ledger when the cache was built/last appended — a
   * mismatch means another process wrote the file and we must reload. */
  fileSize: number;
  /** False when the ledger tail is a partial append (no trailing newline) —
   * the next append must start on a fresh line or it merges into the
   * truncated row and both records become unparseable. */
  endsWithNewline: boolean;
  /** Ledger lines that failed to parse and were skipped at load. */
  corruptLines: number;
}

const IMPORT_FLUSH_LINES = 1000;
const DEFAULT_BACKUP_RETENTION_COUNT = 5;

export class FileMemoryStore {
  readonly dataDir: string;
  private readonly opsPath: string;
  private readonly backupRetentionCount: number;
  private cache?: StoreCache;

  constructor(dataDir: string, backupRetentionCount = DEFAULT_BACKUP_RETENTION_COUNT) {
    this.dataDir = dataDir;
    this.opsPath = path.join(dataDir, 'memory_ops.jsonl');
    this.backupRetentionCount = Math.max(1, backupRetentionCount);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.appendFile(this.opsPath, '');
  }

  async write(
    content: string,
    classification: MemoryClassification,
    enableWrites: boolean
  ): Promise<{ record: MemoryRecord; deduped: boolean }> {
    const cache = await this.loadCache();
    const hash = contentHash(content);
    const existing = cache.activeByHash.get(hash);
    if (existing) {
      const skipped = await this.append({
        id: randomUUID(),
        op: 'write',
        content,
        contentHash: hash,
        kind: classification.kind,
        title: classification.title,
        scope: classification.scope,
        substrates: classification.substrates,
        status: 'skipped-dup',
        deduped: true,
        provenance: { duplicateOf: existing.id },
        createdAt: new Date().toISOString()
      });
      return { record: skipped, deduped: true };
    }

    const record = await this.append({
      id: randomUUID(),
      op: 'write',
      content,
      contentHash: hash,
      kind: classification.kind,
      title: classification.title,
      scope: classification.scope,
      substrates: classification.substrates,
      status: enableWrites ? 'committed' : 'shadow',
      deduped: false,
      createdAt: new Date().toISOString()
    });
    return { record, deduped: false };
  }

  async read(input: MemoryReadInput): Promise<MemoryHit[]> {
    const limit = input.limit ?? 8;
    const query = input.query.trim();
    const records = await this.activeWrites();
    const filtered = records.filter((record) => {
      if (input.project && record.scope.project !== input.project) return false;
      if (typeof input.feature === 'number' && record.scope.feature !== input.feature) return false;
      if (input.phase && record.scope.phase !== input.phase) return false;
      return true;
    });

    const scored = filtered
      .map((record) => ({ record, score: scoreRecord(record, query) }))
      .filter(({ score }) => score > 0 || query.length === 0)
      .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt))
      .slice(0, limit);

    return scored.map(({ record, score }) => ({
      substrate: 'jsonl',
      id: record.id,
      path: this.opsPath,
      title: record.title ?? record.kind ?? 'Memory',
      confidence: Math.max(0.01, Math.min(1, score)),
      scope: record.scope,
      content: record.content ?? '',
      kind: record.kind
    }));
  }

  async forget(input: ForgetInput): Promise<number> {
    if (!input.opId && !input.contentHash) return 0;
    const matches = (await this.activeWrites()).filter((record) => {
      if (input.opId && record.id === input.opId) return true;
      if (input.contentHash && record.contentHash === input.contentHash) return true;
      return false;
    });
    for (const match of matches) {
      await this.append({
        id: randomUUID(),
        op: 'forget',
        contentHash: match.contentHash,
        scope: match.scope,
        substrates: ['jsonl'],
        status: 'tombstoned',
        provenance: { targetId: match.id },
        createdAt: new Date().toISOString()
      });
    }
    return matches.length;
  }

  async link(input: LinkInput): Promise<MemoryRecord> {
    await this.init();
    return this.append({
      id: randomUUID(),
      op: 'link',
      scope: {},
      substrates: ['jsonl'],
      status: 'committed',
      provenance: {
        fromOpId: input.fromOpId,
        toOpId: input.toOpId,
        relation: input.relation
      },
      createdAt: new Date().toISOString()
    });
  }

  async backup(targetDir?: string): Promise<string> {
    await this.init();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupsRoot = path.join(this.dataDir, 'backups');
    const backupDir = targetDir ?? path.join(backupsRoot, stamp);
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(this.opsPath, path.join(backupDir, 'memory_ops.jsonl'));
    // Every import call site takes an unconditional backup() safety snapshot
    // before writing (see cli.ts runImport/runJsonlImport).
    // With no retention that grew unbounded — 2,975 full ledger copies (877GB)
    // from hourly imports filled the disk on 2026-08-25 and tore the live
    // ledger's tail. Prune the default rotation dir back to the newest N; a
    // caller-supplied targetDir is a one-off snapshot and is left alone.
    if (!targetDir) await this.pruneBackups(backupsRoot);
    return backupDir;
  }

  /** Keep only the newest `backupRetentionCount` timestamped backup
   * directories under `backups/`, oldest-first by name (the ISO timestamp
   * stamp sorts lexicographically). Best-effort: a listing or removal failure
   * must not fail the backup that just succeeded. */
  private async pruneBackups(backupsRoot: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(backupsRoot);
    } catch {
      return;
    }
    const stamped = entries.filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort();
    const excess = stamped.slice(0, Math.max(0, stamped.length - this.backupRetentionCount));
    for (const name of excess) {
      await fs.rm(path.join(backupsRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Bulk import. Dedupes by content hash against the live ledger AND within
   * the batch in O(1) per record, and appends in chunks. Unlike agent-facing
   * `write`, duplicate imports are counted and skipped silently — a re-run
   * of the same import must not grow the ledger with skip rows.
   */
  async importRecords(records: Array<{ content: string; scope?: MemoryScope; source?: string; title?: string; kindHint?: import('../types.js').MemoryKind }>): Promise<{
    imported: number;
    skipped: number;
  }> {
    const cache = await this.loadCache();
    let imported = 0;
    let skipped = 0;
    let pending: string[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const prefix = cache.endsWithNewline ? '' : '\n';
      const chunk = `${prefix}${pending.join('\n')}\n`;
      await fs.appendFile(this.opsPath, chunk);
      cache.fileSize += Buffer.byteLength(chunk);
      cache.endsWithNewline = true;
      pending = [];
    };

    for (const record of records) {
      if (!record.content || !record.content.trim()) {
        skipped += 1;
        continue;
      }
      const hash = contentHash(record.content);
      if (cache.activeByHash.has(hash)) {
        skipped += 1;
        continue;
      }
      const row: MemoryRecord = {
        id: randomUUID(),
        op: 'write',
        content: record.content,
        contentHash: hash,
        kind: record.kindHint ?? 'AGENT_TRACE',
        title: record.title ?? record.source ?? 'Imported memory',
        scope: record.scope ?? {},
        substrates: ['jsonl', 'agent_trace'],
        status: 'committed',
        deduped: false,
        createdAt: new Date().toISOString()
      };
      cache.records.push(row);
      this.indexRecord(cache, row);
      pending.push(JSON.stringify(row));
      imported += 1;
      if (pending.length >= IMPORT_FLUSH_LINES) await flush();
    }
    await flush();
    return { imported, skipped };
  }

  async activeRecordsForBackfill(): Promise<MemoryRecord[]> {
    return this.activeWrites();
  }

  /**
   * Bound ledger growth without discarding live memory: compact rows that
   * are only safely removable once nothing else needs them — a dedupe
   * skip-marker, or a forgotten write together with its own forget marker —
   * and only once both are older than `days`. Active (non-tombstoned) writes
   * and anything newer than the cutoff are never touched. Mirrors
   * `ObservabilityStore.prune(days)` in ../observability.js.
   */
  async prune(days: number): Promise<{ kept: number; removed: number; cutoff: string }> {
    const cache = await this.loadCache();
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

    const forgottenBeforeCutoff = new Set<string>();
    for (const record of cache.records) {
      if (record.op !== 'forget' || record.createdAt >= cutoff) continue;
      const targetId = record.provenance?.['targetId'];
      if (typeof targetId === 'string') forgottenBeforeCutoff.add(targetId);
    }

    const kept = cache.records.filter((record) => {
      if (record.createdAt >= cutoff) return true;
      if (record.op === 'write' && record.status === 'skipped-dup') return false;
      if (record.op === 'write' && forgottenBeforeCutoff.has(record.id)) return false;
      if (record.op === 'forget') {
        const targetId = record.provenance?.['targetId'];
        if (typeof targetId === 'string' && forgottenBeforeCutoff.has(targetId)) return false;
      }
      return true;
    });

    const removed = cache.records.length - kept.length;
    if (removed > 0) {
      const body = kept.length ? `${kept.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
      await fs.writeFile(this.opsPath, body, 'utf8');
      this.cache = undefined;
    }
    return { kept: kept.length, removed, cutoff };
  }

  async stats(): Promise<{
    ok: boolean;
    path: string;
    bytes: number;
    records: number;
    activeRecords: number;
    corruptLines: number;
  }> {
    await this.init();
    const [stat, cache, active] = await Promise.all([
      fs.stat(this.opsPath),
      this.loadCache(),
      this.activeWrites()
    ]);
    return {
      ok: true,
      path: this.opsPath,
      bytes: stat.size,
      records: cache.records.length,
      activeRecords: active.length,
      corruptLines: cache.corruptLines
    };
  }

  private async append(record: MemoryRecord): Promise<MemoryRecord> {
    const cache = await this.loadCache();
    const line = `${JSON.stringify(record)}\n`;
    const chunk = cache.endsWithNewline ? line : `\n${line}`;
    const knownGoodSize = cache.fileSize;
    try {
      await fs.appendFile(this.opsPath, chunk);
    } catch (error) {
      // A failed append (2026-08-25: ENOSPC mid-write) can still land a
      // partial chunk on disk — a fragment with no closing brace that would
      // poison every future parse as a brand-new corrupt tail. Truncate back
      // to the last byte offset we know was intact before this attempt so
      // one failed record can never taint the ledger; the caller still sees
      // the original failure.
      await this.truncateToKnownGoodSize(knownGoodSize);
      throw error;
    }
    cache.records.push(record);
    this.indexRecord(cache, record);
    cache.fileSize += Buffer.byteLength(chunk);
    cache.endsWithNewline = true;
    return record;
  }

  private async truncateToKnownGoodSize(size: number): Promise<void> {
    try {
      const handle = await fs.open(this.opsPath, 'r+');
      try {
        await handle.truncate(size);
      } finally {
        await handle.close();
      }
    } catch {
      // Best-effort recovery — if this fails too (e.g. the disk is so full
      // even a metadata-only truncate can't proceed) the original append
      // error still propagates to the caller unchanged.
    }
  }

  /** Parse the ledger once and keep it warm; reload only when the file size
   * on disk stops matching (another process appended). A line that fails to
   * parse (torn append, disk-full truncation) is skipped and counted instead
   * of thrown: one poisoned row must never take down every read and write. */
  private async loadCache(): Promise<StoreCache> {
    await this.init();
    const stat = await fs.stat(this.opsPath);
    if (this.cache && this.cache.fileSize === stat.size) return this.cache;
    const raw = await fs.readFile(this.opsPath, 'utf8');
    const records: MemoryRecord[] = [];
    let corruptLines = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecord);
      } catch {
        corruptLines += 1;
      }
    }
    if (corruptLines > 0) {
      console.error(
        `[file-store] skipped ${corruptLines} unparseable ledger line(s) in ${this.opsPath}; ` +
          'the bytes are preserved on disk — quarantine them to clear this warning'
      );
    }
    const cache: StoreCache = {
      records,
      activeByHash: new Map(),
      tombstonedIds: new Set(),
      tombstonedHashes: new Set(),
      fileSize: stat.size,
      endsWithNewline: raw.length === 0 || raw.endsWith('\n'),
      corruptLines
    };
    for (const record of records) this.indexRecord(cache, record);
    this.cache = cache;
    return cache;
  }

  private indexRecord(cache: StoreCache, record: MemoryRecord): void {
    if (record.op === 'forget') {
      const targetId = record.provenance?.['targetId'];
      if (typeof targetId === 'string') cache.tombstonedIds.add(targetId);
      if (record.contentHash) {
        cache.tombstonedHashes.add(record.contentHash);
        cache.activeByHash.delete(record.contentHash);
      }
      return;
    }
    if (record.op !== 'write' || record.status === 'skipped-dup') return;
    if (cache.tombstonedIds.has(record.id)) return;
    if (record.contentHash && cache.tombstonedHashes.has(record.contentHash)) return;
    if (record.contentHash && !cache.activeByHash.has(record.contentHash)) {
      cache.activeByHash.set(record.contentHash, record);
    }
  }

  private async activeWrites(): Promise<MemoryRecord[]> {
    const cache = await this.loadCache();
    return cache.records.filter((record) => {
      if (record.op !== 'write') return false;
      if (record.status === 'skipped-dup') return false;
      if (cache.tombstonedIds.has(record.id)) return false;
      if (record.contentHash && cache.tombstonedHashes.has(record.contentHash)) return false;
      return true;
    });
  }
}

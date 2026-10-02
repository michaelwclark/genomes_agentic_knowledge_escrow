import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { createEmbeddingProvider, type EmbeddingProvider } from '../embedding.js';
import type { BrainConfig, MemoryHit, MemoryRecord } from '../types.js';

/**
 * Loads `node:sqlite` while swallowing only its own `ExperimentalWarning`.
 * `DatabaseSync` is loaded lazily (not as a static import) so projects that
 * never enable the sqlite layer never trigger the warning or pay the load
 * cost, and so the warning is emitted at most once per process regardless of
 * how many stores are constructed.
 */
let sqliteModule: typeof import('node:sqlite') | undefined;

function loadSqliteModule(): typeof import('node:sqlite') {
  if (sqliteModule) return sqliteModule;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const type = typeof args[0] === 'string' ? (args[0] as string) : (args[0] as { type?: string } | undefined)?.type;
    const message = warning instanceof Error ? warning.message : warning;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEmitWarning as any).call(process, warning, ...args);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule('node:sqlite');
    if (!sqliteModule) throw new Error('node:sqlite builtin module is unavailable on this Node runtime');
    return sqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * Hybrid lexical (FTS5/bm25) + optional vector (brute-force cosine) search
 * fusion. Each ranking is normalized to [0, 1] independently, then combined
 * as a weighted sum (0.6 lexical, 0.4 vector when a vector score exists;
 * 1.0 lexical when it does not). This is simple normalized-score fusion
 * rather than reciprocal-rank fusion: at our scale (<50k rows) the raw
 * scores are stable enough that rank-only fusion would throw away useful
 * signal from strong bm25/cosine matches.
 */
const LEXICAL_WEIGHT = 0.6;
const VECTOR_WEIGHT = 0.4;
const VECTOR_MIN_SIMILARITY = 0.05;

interface MemoryDocumentRow {
  external_id: string;
  project: string | null;
  source: string | null;
  kind: string | null;
  title: string | null;
  content: string;
  content_hash: string | null;
  created_at: string;
  embedding: Uint8Array | null;
  embedding_dims: number | null;
}

export class SqliteDocumentStore {
  private db?: DatabaseSync;
  private readonly embeddingProvider: EmbeddingProvider;
  private upsertStatement?: StatementSync;
  private deleteStatement?: StatementSync;

  constructor(
    private readonly dbPath: string,
    config: Pick<BrainConfig, 'embeddingProvider' | 'ollamaUrl' | 'ollamaModel' | 'localModelDir'>
  ) {
    this.embeddingProvider = createEmbeddingProvider({
      provider: config.embeddingProvider,
      ollamaUrl: config.ollamaUrl,
      ollamaModel: config.ollamaModel,
      localModelDir: config.localModelDir
    });
  }

  async upsertMemory(record: MemoryRecord): Promise<void> {
    if (!record.content?.trim()) return;
    const title = record.title ?? record.kind ?? 'Memory';
    const content = record.content;
    const vector = await this.embeddingProvider.embed(`${title} ${content}`);
    const db = this.open();
    const embeddingBlob = vector ? floatArrayToBlob(vector) : null;
    const statement = this.upsertStatement ?? (this.upsertStatement = db.prepare(
      `INSERT INTO memory_documents
        (external_id, project, source, kind, title, content, content_hash, created_at, embedding, embedding_dims)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         project = excluded.project,
         source = excluded.source,
         kind = excluded.kind,
         title = excluded.title,
         content = excluded.content,
         content_hash = excluded.content_hash,
         created_at = excluded.created_at,
         embedding = excluded.embedding,
         embedding_dims = excluded.embedding_dims`
    ));
    statement.run(
      record.id,
      record.scope.project ?? null,
      record.scope.source ?? null,
      record.kind ?? null,
      title,
      content,
      record.contentHash ?? null,
      record.createdAt,
      embeddingBlob,
      vector ? vector.length : null
    );
  }

  async upsertMemories(records: MemoryRecord[]): Promise<{ upserted: number; skipped: number }> {
    let upserted = 0;
    let skipped = 0;
    for (const record of records) {
      if (!record.content?.trim()) {
        skipped += 1;
        continue;
      }
      await this.upsertMemory(record);
      upserted += 1;
    }
    return { upserted, skipped };
  }

  /** Clear and rebuild the store from the ledger's active, non-tombstoned write records. */
  async reindex(records: MemoryRecord[]): Promise<{ upserted: number; skipped: number }> {
    const db = this.open();
    db.exec('DELETE FROM memory_documents');
    this.upsertStatement = undefined;
    return this.upsertMemories(records);
  }

  async search(query: string, limit: number, project?: string): Promise<MemoryHit[]> {
    const db = this.open();
    const lexicalHits = this.lexicalSearch(db, query, project);
    const lexicalByExternalId = new Map(lexicalHits.map((hit) => [hit.externalId, hit]));

    let vectorByExternalId = new Map<string, { row: MemoryDocumentRow; similarity: number }>();
    if (this.embeddingProvider.id !== 'none' && query.trim()) {
      const queryVector = await this.embeddingProvider.embed(query);
      if (queryVector) vectorByExternalId = this.vectorSearch(db, queryVector, project);
    }

    const externalIds = new Set<string>([...lexicalByExternalId.keys(), ...vectorByExternalId.keys()]);
    if (externalIds.size === 0) return [];

    const rowsById = this.fetchRows(db, [...externalIds]);
    const fused: Array<{ row: MemoryDocumentRow; confidence: number }> = [];
    for (const externalId of externalIds) {
      const row = rowsById.get(externalId);
      if (!row) continue;
      const lexicalScore = lexicalByExternalId.get(externalId)?.normalizedScore ?? 0;
      const vectorEntry = vectorByExternalId.get(externalId);
      const confidence = vectorEntry
        ? LEXICAL_WEIGHT * lexicalScore + VECTOR_WEIGHT * vectorEntry.similarity
        : lexicalScore;
      fused.push({ row, confidence: Math.max(0.01, Math.min(1, confidence)) });
    }

    return fused
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit)
      .map(({ row, confidence }) => ({
        substrate: 'sqlite' as const,
        id: row.external_id,
        path: this.dbPath,
        title: row.title ?? row.kind ?? 'Memory',
        confidence,
        scope: { project: row.project ?? undefined, source: row.source ?? undefined },
        content: row.content,
        kind: (row.kind ?? undefined) as MemoryHit['kind']
      }));
  }

  private lexicalSearch(
    db: DatabaseSync,
    query: string,
    project?: string
  ): Array<{ externalId: string; normalizedScore: number }> {
    const matchExpression = sanitizeFtsQuery(query);
    if (!matchExpression) return [];
    const params: SQLInputValue[] = [matchExpression];
    let where = 'memory_documents_fts MATCH ?';
    if (project) {
      where += ' AND d.project = ?';
      params.push(project);
    }
    const statement = db.prepare(
      `SELECT d.external_id AS external_id, bm25(memory_documents_fts) AS rank
       FROM memory_documents_fts
       JOIN memory_documents d ON d.rowid = memory_documents_fts.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT 200`
    );
    const rows = statement.all(...params) as unknown as Array<{ external_id: string; rank: number }>;
    if (rows.length === 0) return [];
    // bm25() is lower-is-better and unbounded below zero; negate then
    // min-max normalize across this query's result set into [0, 1].
    const scores = rows.map((row) => -Number(row.rank));
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    return rows.map((row, index) => ({
      externalId: row.external_id,
      normalizedScore: range > 0 ? (scores[index]! - min) / range : 1
    }));
  }

  private vectorSearch(
    db: DatabaseSync,
    queryVector: number[],
    project?: string
  ): Map<string, { row: MemoryDocumentRow; similarity: number }> {
    const params: SQLInputValue[] = [];
    let where = 'embedding IS NOT NULL';
    if (project) {
      where += ' AND project = ?';
      params.push(project);
    }
    const statement = db.prepare(
      `SELECT external_id, project, source, kind, title, content, content_hash, created_at, embedding, embedding_dims
       FROM memory_documents
       WHERE ${where}`
    );
    const rows = statement.all(...params) as unknown as MemoryDocumentRow[];
    const result = new Map<string, { row: MemoryDocumentRow; similarity: number }>();
    const candidates: Array<{ row: MemoryDocumentRow; similarity: number }> = [];
    for (const row of rows) {
      if (!row.embedding || !row.embedding_dims || row.embedding_dims !== queryVector.length) continue;
      const vector = blobToFloatArray(row.embedding);
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity > VECTOR_MIN_SIMILARITY) candidates.push({ row, similarity });
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    for (const candidate of candidates.slice(0, 200)) result.set(candidate.row.external_id, candidate);
    return result;
  }

  private fetchRows(db: DatabaseSync, externalIds: string[]): Map<string, MemoryDocumentRow> {
    if (externalIds.length === 0) return new Map();
    const placeholders = externalIds.map(() => '?').join(',');
    const statement = db.prepare(
      `SELECT external_id, project, source, kind, title, content, content_hash, created_at, embedding, embedding_dims
       FROM memory_documents
       WHERE external_id IN (${placeholders})`
    );
    const rows = statement.all(...(externalIds as SQLInputValue[])) as unknown as MemoryDocumentRow[];
    return new Map(rows.map((row) => [row.external_id, row]));
  }

  async delete(input: { opId?: string; contentHash?: string }): Promise<number> {
    if (!input.opId && !input.contentHash) return 0;
    const db = this.open();
    let removed = 0;
    if (input.opId) {
      const statement = this.deleteStatement ?? (this.deleteStatement = db.prepare('DELETE FROM memory_documents WHERE external_id = ?'));
      const result = statement.run(input.opId);
      removed += Number(result.changes ?? 0);
    }
    if (input.contentHash) {
      const statement = db.prepare('DELETE FROM memory_documents WHERE content_hash = ?');
      const result = statement.run(input.contentHash);
      removed += Number(result.changes ?? 0);
    }
    return removed;
  }

  async countDocuments(): Promise<number> {
    const db = this.open();
    const row = db.prepare('SELECT count(*) AS count FROM memory_documents').get() as { count: number };
    return Number(row.count ?? 0);
  }

  async health(): Promise<{ status: 'ok' | 'error'; detail: string }> {
    try {
      const count = await this.countDocuments();
      return { status: 'ok', detail: `${this.dbPath} (${count} document(s))` };
    } catch (error) {
      return { status: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    this.upsertStatement = undefined;
    this.deleteStatement = undefined;
    this.db?.close();
    this.db = undefined;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const { DatabaseSync: DatabaseSyncCtor } = loadSqliteModule();
    const db = new DatabaseSyncCtor(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_documents (
        external_id TEXT PRIMARY KEY,
        project TEXT,
        source TEXT,
        kind TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        embedding BLOB,
        embedding_dims INTEGER
      )
    `);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_documents_fts USING fts5(
          title, content, content='memory_documents', content_rowid='rowid'
        )
      `);
    } catch (error) {
      db.close();
      // Older Node 22 builds (e.g. 22.14) ship node:sqlite without FTS5; the
      // sqlite layer is unusable there, so say which runtime to install.
      if (error instanceof Error && /no such module: fts5/i.test(error.message)) {
        throw new Error(
          `sqlite layer needs FTS5, which node:sqlite in Node ${process.versions.node} lacks; use Node 22.22+ (or the bundled Knowledge Escrow executable)`
        );
      }
      throw error;
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_documents_ai AFTER INSERT ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_documents_ad AFTER DELETE ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(memory_documents_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_documents_au AFTER UPDATE ON memory_documents BEGIN
        INSERT INTO memory_documents_fts(memory_documents_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO memory_documents_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END
    `);
    this.db = db;
    return db;
  }
}

/**
 * Turns free-text user input into a safe FTS5 MATCH expression: split into
 * word-ish tokens, quote each one (doubling any embedded `"`), and OR them
 * together. An all-punctuation or empty query yields an empty string, which
 * the caller must treat as "no lexical match" rather than passing to
 * MATCH — an empty MATCH expression throws.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/[^A-Za-z0-9_']+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function floatArrayToBlob(values: number[]): Uint8Array {
  const floatArray = new Float32Array(values);
  return new Uint8Array(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
}

function blobToFloatArray(blob: Uint8Array): Float32Array {
  // The blob read back from SQLite may not be aligned to a 4-byte boundary
  // within its backing ArrayBuffer, which Float32Array requires. Copy into a
  // freshly allocated, aligned buffer rather than viewing the original.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function cosineSimilarity(a: number[], b: Float32Array): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dot += valueA * valueB;
    magnitudeA += valueA * valueA;
    magnitudeB += valueB * valueB;
  }
  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  return denominator > 0 ? dot / denominator : 0;
}

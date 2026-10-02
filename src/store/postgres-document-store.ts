import pg from 'pg';
import { createEmbeddingProvider, toPgVectorLiteral, type EmbeddingProvider } from '../embedding.js';
import type { BrainConfig } from '../types.js';
import type { MemoryHit, MemoryRecord } from '../types.js';

const { Pool } = pg;

export function sanitizePostgresText(value: string): string {
  return value.replace(/\u0000/g, '');
}

export class PostgresDocumentStore {
  private pool?: pg.Pool;
  private initialized = false;
  private vectorDimensions?: number;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(
    private readonly url: string,
    configOrProvider:
      | Pick<BrainConfig, 'embeddingProvider' | 'ollamaUrl' | 'ollamaModel' | 'localModelDir'>
      | BrainConfig['embeddingProvider'] = 'none'
  ) {
    if (typeof configOrProvider === 'string') {
      this.embeddingProvider = createEmbeddingProvider({
        provider: configOrProvider,
        ollamaUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'nomic-embed-text'
      });
    } else {
      this.embeddingProvider = createEmbeddingProvider({
        provider: configOrProvider.embeddingProvider,
        ollamaUrl: configOrProvider.ollamaUrl,
        ollamaModel: configOrProvider.ollamaModel,
        localModelDir: configOrProvider.localModelDir
      });
    }
  }

  async upsertMemory(record: MemoryRecord): Promise<void> {
    if (!record.content) return;
    const title = sanitizePostgresText(record.title ?? record.kind ?? 'Memory');
    const content = sanitizePostgresText(record.content);
    const vector = await this.embedMemory(`${title} ${content}`);
    await this.ensureSchema(vector?.length);
    const embedding = vector ? toPgVectorLiteral(vector) : null;
    const metadata = sanitizePostgresText(JSON.stringify({
      kind: record.kind,
      scope: record.scope,
      contentHash: record.contentHash,
      createdAt: record.createdAt
    }));
    await this.query(
      `INSERT INTO memory_documents (external_id, project, source, title, content, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       ON CONFLICT (external_id)
       DO UPDATE SET project = EXCLUDED.project,
                     source = EXCLUDED.source,
                     title = EXCLUDED.title,
                     content = EXCLUDED.content,
                     embedding = EXCLUDED.embedding,
                     metadata = EXCLUDED.metadata`,
      [
        sanitizePostgresText(record.id),
        record.scope.project ? sanitizePostgresText(record.scope.project) : null,
        record.scope.source ? sanitizePostgresText(record.scope.source) : null,
        title,
        content,
        embedding,
        metadata
      ]
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

  async countDocuments(): Promise<number> {
    await this.ensureSchema();
    const result = await this.query('SELECT count(*)::int AS count FROM memory_documents', []);
    return Number(result.rows[0]?.count ?? 0);
  }

  async hasDocument(externalId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.query('SELECT 1 FROM memory_documents WHERE external_id = $1 LIMIT 1', [externalId]);
    return (result.rowCount ?? 0) > 0;
  }

  async missingRecords(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    await this.ensureSchema();
    const ids = records.map((record) => record.id);
    if (!ids.length) return [];
    const result = await this.query('SELECT external_id FROM memory_documents WHERE external_id = ANY($1)', [ids]);
    const existing = new Set(result.rows.map((row) => String(row.external_id)));
    return records.filter((record) => !existing.has(record.id));
  }

  async search(query: string, limit: number, project?: string): Promise<MemoryHit[]> {
    await this.ensureSchema();
    if (this.embeddingProvider.id !== 'none' && query.trim()) {
      return this.vectorSearch(query, limit, project);
    }
    const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
    const params: unknown[] = [like, limit];
    let where = `content ILIKE $1`;
    if (project) {
      params.splice(1, 0, project);
      where += ` AND project = $2`;
    }
    const limitParam = project ? '$3' : '$2';
    const result = await this.query(
      `SELECT external_id, project, source, title, content, metadata
       FROM memory_documents
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      params
    );
    return result.rows.map((row) => ({
      substrate: 'pgvector',
      id: row.external_id,
      path: 'postgres://memory_documents',
      title: row.title,
      confidence: 0.55,
      scope: { project: row.project ?? undefined, source: row.source ?? undefined },
      content: row.content,
      kind: row.metadata?.kind
    }));
  }

  private async vectorSearch(queryText: string, limit: number, project?: string): Promise<MemoryHit[]> {
    const embedded = await this.embedMemory(queryText);
    if (!embedded) throw new Error('pgvector search requires an embedding provider');
    await this.ensureSchema(embedded.length);
    const vector = toPgVectorLiteral(embedded);
    const params: unknown[] = [vector, limit];
    let where = 'embedding IS NOT NULL';
    if (project) {
      params.splice(1, 0, project);
      where += ' AND project = $2';
    }
    const limitParam = project ? '$3' : '$2';
    const result = await this.query(
      `SELECT external_id, project, source, title, content, metadata, (embedding <=> $1::vector) AS distance
       FROM memory_documents
       WHERE ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT ${limitParam}`,
      params
    );
    return result.rows.map((row) => ({
      substrate: 'pgvector',
      id: row.external_id,
      path: 'postgres://memory_documents',
      title: row.title,
      confidence: Math.max(0.01, Math.min(1, 1 / (1 + Number(row.distance ?? 1)))),
      scope: { project: row.project ?? undefined, source: row.source ?? undefined },
      content: row.content,
      kind: row.metadata?.kind
    }));
  }

  async ping(): Promise<boolean> {
    const probe = await this.embedMemory('Knowledge Escrow pgvector health check');
    await this.ensureSchema(probe?.length);
    await this.query('SELECT 1', []);
    return true;
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
    this.initialized = false;
  }

  private async ensureSchema(vectorDimensions?: number): Promise<void> {
    if (this.initialized) {
      if (vectorDimensions && this.vectorDimensions && this.vectorDimensions !== vectorDimensions) {
        throw new Error(`pgvector dimension mismatch: schema=${this.vectorDimensions}, embedding=${vectorDimensions}`);
      }
      return;
    }
    const dimensions = vectorDimensions ?? this.embeddingProvider.dimensions ?? 1536;
    await this.query('CREATE EXTENSION IF NOT EXISTS vector', []);
    await this.query('CREATE EXTENSION IF NOT EXISTS pgcrypto', []);
    await this.query(
      `CREATE TABLE IF NOT EXISTS memory_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id TEXT UNIQUE,
        project TEXT,
        source TEXT,
        title TEXT,
        content TEXT NOT NULL,
        embedding vector(${dimensions}),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      []
    );
    const existing = await this.query(
      `SELECT atttypmod AS typmod
       FROM pg_attribute
       WHERE attrelid = 'memory_documents'::regclass
         AND attname = 'embedding'
         AND NOT attisdropped`,
      []
    );
    const typmod = Number(existing.rows[0]?.typmod ?? -1);
    const existingDimensions = typmod > 0 ? typmod : dimensions;
    if (vectorDimensions && existingDimensions !== vectorDimensions) {
      throw new Error(`pgvector dimension mismatch: schema=${existingDimensions}, embedding=${vectorDimensions}`);
    }
    this.vectorDimensions = existingDimensions;
    await this.query('CREATE INDEX IF NOT EXISTS memory_documents_project_idx ON memory_documents(project)', []);
    await this.query(
      'CREATE INDEX IF NOT EXISTS memory_documents_metadata_idx ON memory_documents USING GIN(metadata)',
      []
    );
    await this.query(
      'CREATE INDEX IF NOT EXISTS memory_documents_embedding_hnsw_idx ON memory_documents USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL',
      []
    );
    this.initialized = true;
  }

  private async embedMemory(text: string): Promise<number[] | null> {
    return this.embeddingProvider.embed(text);
  }

  private async query(sql: string, params: unknown[]) {
    const pool = this.getPool();
    return pool.query(sql, params);
  }

  private getPool(): pg.Pool {
    if (!this.pool) this.pool = new Pool({ connectionString: this.url });
    return this.pool;
  }
}

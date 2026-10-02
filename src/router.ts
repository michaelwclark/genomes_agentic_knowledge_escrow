import { classifyMemory } from './classifier.js';
import { FileMemoryStore } from './store/file-store.js';
import { GrepSidecarStore } from './store/grep-sidecar-store.js';
import { HotMemoryStore } from './store/hot-memory-store.js';
import { PostgresDocumentStore } from './store/postgres-document-store.js';
import { SqliteDocumentStore } from './store/sqlite-document-store.js';
import { ProjectFileStore } from './store/project-file-store.js';
import { dedupeHits } from './store/scoring.js';
import { redactSensitive } from './redaction.js';
import { MetricsStore } from './observability.js';
import { SERVICE_VERSION } from './version.js';
import type {
  AnalyticsSummary,
  BrainConfig,
  ForgetInput,
  LayerHealth,
  LinkInput,
  MemoryHit,
  MemoryReadInput,
  MemoryWriteInput,
  MemoryOperationMetric,
  MemoryOperationName,
  MemoryWriteResult
} from './types.js';

export class MemoryRouter {
  private readonly postgresDocuments?: PostgresDocumentStore;
  private readonly sqliteDocuments?: SqliteDocumentStore;
  private readonly projectFiles: ProjectFileStore;
  private readonly grepSidecar: GrepSidecarStore;
  private readonly hotMemory: HotMemoryStore;
  private readonly metrics: MetricsStore;
  private readonly observabilityWarnings: string[] = [];

  constructor(
    private readonly config: BrainConfig,
    private readonly store = new FileMemoryStore(config.dataDir, config.backupRetentionCount)
  ) {
    this.postgresDocuments = config.postgresUrl
      ? new PostgresDocumentStore(config.postgresUrl, config)
      : undefined;
    this.sqliteDocuments = config.sqlitePath
      ? new SqliteDocumentStore(config.sqlitePath, config)
      : undefined;
    this.projectFiles = new ProjectFileStore(config);
    this.grepSidecar = new GrepSidecarStore(config);
    this.hotMemory = HotMemoryStore.fromConfig(config);
    this.metrics = new MetricsStore(config.dataDir, config.metricsEnabled, config.metricsRetentionDays);
  }

  async read(input: MemoryReadInput) {
    const startedAt = Date.now();
    try {
      const result = await this.readUnobserved(input);
      const substrateHits: Record<string, number> = {};
      for (const hit of result.hits) substrateHits[hit.substrate] = (substrateHits[hit.substrate] ?? 0) + 1;
      await this.recordMetric({
        method: 'read',
        durationMs: Date.now() - startedAt,
        ok: true,
        resultCount: result.count,
        warningCount: result.warnings.length,
        substrateHits
      });
      return result;
    } catch (error) {
      await this.recordFailure('read', startedAt, error);
      throw error;
    }
  }

  private async readUnobserved(input: MemoryReadInput) {
    const warnings: string[] = [];
    const limit = input.limit ?? 8;
    if (this.postgresDocuments && this.config.embeddingProvider !== 'none' && input.query.trim()) {
      const pgvectorHits = await this.postgresDocuments.search(input.query, limit, input.project);
      if (pgvectorHits.length > 0) {
        return this.formatReadResult(pgvectorHits, warnings, limit);
      }
      warnings.push('pgvector primary read returned zero hits; falling back to lexical layers');
    }
    const readJobs: Array<{ id: string; run: () => Promise<any[]> }> = [
      { id: 'jsonl', run: () => this.store.read(input) },
      { id: 'project_files', run: () => this.projectFiles.read(input) },
      { id: 'grep_sidecar', run: () => this.grepSidecar.read(input) },
      { id: 'hot_memory', run: () => this.hotMemory.read(input) }
    ];
    if (this.postgresDocuments && input.query.trim()) {
      readJobs.push({
        id: 'pgvector',
        run: () => this.postgresDocuments?.search(input.query, limit, input.project) ?? Promise.resolve([])
      });
    }
    if (this.sqliteDocuments) {
      readJobs.push({
        id: 'sqlite',
        run: () => this.sqliteDocuments?.search(input.query, limit, input.project) ?? Promise.resolve([])
      });
    }
    const results = await Promise.allSettled(readJobs.map((job) => job.run()));
    const hits: MemoryHit[] = [];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const job = readJobs[i] as { id: string; run: () => Promise<any[]> };
      if (result?.status === 'fulfilled') {
        hits.push(...result.value);
      } else {
        warnings.push(`${job.id} read skipped: ${result?.reason instanceof Error ? result.reason.message : String(result?.reason)}`);
      }
    }
    return this.formatReadResult(hits, warnings, limit);
  }

  private formatReadResult(hits: MemoryHit[], warnings: string[], limit: number) {
    const merged = dedupeHits(hits).sort((a, b) => b.confidence - a.confidence).slice(0, limit);
    return {
      count: merged.length,
      warnings,
      hits: merged.map((hit) => ({
        substrate: hit.substrate,
        id: hit.id,
        path: hit.path,
        title: hit.title,
        confidence: Number(hit.confidence.toFixed(3)),
        scope: hit.scope,
        kind: hit.kind,
        // Defense in depth: layers that read raw files (e.g. hot_memory) may
        // surface content written before redaction existed, or content a
        // substrate stores outside the router's write path. Redact before
        // slicing so a sensitive value spanning the 400-char boundary is
        // still caught.
        preview: (this.config.redactionEnabled !== false
          ? redactSensitive(hit.content, this.config.redactionPatterns).text
          : hit.content
        ).slice(0, 400)
      }))
    };
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const startedAt = Date.now();
    try {
      const warnings: string[] = [];
      let content = input.content;
      if (this.config.redactionEnabled !== false) {
        const redacted = redactSensitive(content, this.config.redactionPatterns);
        content = redacted.text;
        const redactedCounts = Object.entries(redacted.counts).filter(([, count]) => count > 0);
        if (redactedCounts.length > 0) {
          warnings.push(
            `redacted ${redactedCounts.reduce((sum, [, count]) => sum + count, 0)} sensitive value(s): ${redactedCounts
              .map(([name, count]) => `${name}=${count}`)
              .join(',')}`
          );
        }
      }
      const classification = classifyMemory(content, input.scope, input.kindHint);
      const result = await this.store.write(content, classification, this.config.enableWrites);
      const substrateSkips: Record<string, number> = {};
      const recordSubstrateSkip = (substrate: string, error: unknown, label = substrate) => {
        warnings.push(`${label} write skipped: ${error instanceof Error ? error.message : String(error)}`);
        substrateSkips[substrate] = (substrateSkips[substrate] ?? 0) + 1;
      };
      const writes: Array<{ substrate: MemoryWriteResult['writes'][number]['substrate']; path: string }> = [
        { substrate: 'jsonl', path: this.config.dataDir }
      ];
      if (!result.deduped && this.config.enableWrites) {
        try {
          writes.push(...(await this.projectFiles.append(result.record)));
        } catch (error) {
          recordSubstrateSkip('project_memory', error, 'project file');
        }
        if (this.postgresDocuments) {
          try {
            await this.postgresDocuments.upsertMemory(result.record);
            writes.push({ substrate: 'pgvector', path: 'postgres://memory_documents' });
          } catch (error) {
            recordSubstrateSkip('pgvector', error, 'postgres document');
          }
        }
        if (this.sqliteDocuments) {
          try {
            await this.sqliteDocuments.upsertMemory(result.record);
            writes.push({ substrate: 'sqlite', path: this.config.sqlitePath ?? 'sqlite://escrow' });
          } catch (error) {
            recordSubstrateSkip('sqlite', error, 'sqlite document');
          }
        }
      }
      const response = {
        kind: classification.kind,
        scope: classification.scope,
        deduped: result.deduped,
        recordId: result.record.id,
        writes,
        warnings
      };
      await this.recordMetric({
        method: 'write',
        durationMs: Date.now() - startedAt,
        ok: true,
        resultCount: writes.length,
        warningCount: warnings.length,
        deduped: result.deduped,
        substrateHits: Object.fromEntries(writes.map((write) => [write.substrate, 1])),
        substrateSkips
      });
      return response;
    } catch (error) {
      await this.recordFailure('write', startedAt, error);
      throw error;
    }
  }

  async forget(input: ForgetInput) {
    const startedAt = Date.now();
    try {
      const tombstoned = await this.store.forget(input);
      if (this.sqliteDocuments) {
        try {
          await this.sqliteDocuments.delete(input);
        } catch {
          // Best-effort: the JSONL tombstone is the source of truth for forget.
        }
      }
      await this.recordMetric({ method: 'forget', durationMs: Date.now() - startedAt, ok: true, resultCount: tombstoned });
      return { tombstoned };
    } catch (error) {
      await this.recordFailure('forget', startedAt, error);
      throw error;
    }
  }

  async link(input: LinkInput) {
    const startedAt = Date.now();
    try {
      const record = await this.store.link(input);
      await this.recordMetric({ method: 'link', durationMs: Date.now() - startedAt, ok: true, resultCount: 1 });
      return { linkId: record.id, relation: input.relation };
    } catch (error) {
      await this.recordFailure('link', startedAt, error);
      throw error;
    }
  }

  async backup(targetDir?: string) {
    return { backupDir: await this.store.backup(targetDir) };
  }

  getStore() {
    return this.store;
  }

  getConfig(): BrainConfig {
    return this.config;
  }

  getPostgresDocumentStore() {
    return this.postgresDocuments;
  }

  getSqliteDocumentStore() {
    return this.sqliteDocuments;
  }

  getMetricsStore() {
    return this.metrics;
  }

  async analytics(hours = 24): Promise<AnalyticsSummary> {
    return this.metrics.summary(hours);
  }

  async recentMetrics(limit = 20): Promise<{ source: 'local'; events: MemoryOperationMetric[]; warnings?: string[] }> {
    return { source: 'local', events: await this.metrics.recent(limit) };
  }

  async pruneMetrics(days = this.config.metricsRetentionDays): Promise<{
    days: number;
    cutoff: string;
    local: { kept: number; removed: number };
    warnings?: string[];
  }> {
    const local = await this.metrics.prune(days);
    return {
      days,
      cutoff: local.cutoff,
      local: { kept: local.kept, removed: local.removed }
    };
  }

  /** Compact the ledger's safely-prunable rows (see FileMemoryStore.prune) so
   * memory_ops.jsonl cannot grow unbounded. */
  async pruneLedger(days = this.config.ledgerRetentionDays): Promise<{ days: number; kept: number; removed: number; cutoff: string }> {
    const result = await this.store.prune(days);
    return { days, ...result };
  }

  async healthReport(checkDatabases = false) {
    const [metrics, store, databaseHealth] = await Promise.all([
      this.metrics.health(this.config.healthFreshnessMinutes),
      this.store.stats(),
      checkDatabases ? this.pingDatabases() : Promise.resolve(undefined)
    ]);
    const layers = this.layerHealth();
    const findings: string[] = [...this.observabilityWarnings];
    if (metrics.status === 'error') findings.push(`metrics store error: ${metrics.detail ?? 'unknown error'}`);
    if (metrics.stale) findings.push(`metrics have not recorded an operation since ${metrics.lastEventAt}`);
    if (layers.some((layer) => layer.status === 'error')) findings.push('one or more retrieval layers report an error');
    for (const [database, status] of Object.entries(databaseHealth ?? {})) {
      if (status !== 'ok') findings.push(`${database} health check failed: ${status}`);
    }
    const unhealthy = Object.values(databaseHealth ?? {}).some((value) => value !== 'ok') || !store.ok;
    const degraded = !unhealthy && findings.length > 0;
    return {
      ok: !unhealthy,
      status: unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
      service: 'knowledge-escrow',
      version: SERVICE_VERSION,
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      dataDir: this.config.dataDir,
      projectRoot: this.config.projectRoot ?? null,
      writesEnabled: this.config.enableWrites,
      metricsEnabled: this.config.metricsEnabled,
      store,
      metrics,
      layers,
      databaseHealth,
      findings
    };
  }

  async pingDatabases() {
    const result: Record<string, string> = {};
    if (this.postgresDocuments) {
      try {
        result['postgres'] = (await this.postgresDocuments.ping()) ? 'ok' : 'failed';
      } catch (error) {
        result['postgres'] = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.sqliteDocuments) {
      const sqliteHealth = await this.sqliteDocuments.health();
      result['sqlite'] = sqliteHealth.status === 'ok' ? 'ok' : sqliteHealth.detail;
    }
    return result;
  }

  async close() {
    await Promise.allSettled([
      this.postgresDocuments?.close(),
      this.sqliteDocuments?.close()
    ]);
  }

  health() {
    return {
      ok: true,
      service: 'knowledge-escrow',
      version: SERVICE_VERSION,
      dataDir: this.config.dataDir,
      projectRoot: this.config.projectRoot ?? null,
      writesEnabled: this.config.enableWrites,
      metricsEnabled: this.config.metricsEnabled,
      layers: this.layerHealth()
    };
  }

  layerHealth(): LayerHealth[] {
    return [
      { id: 'jsonl', status: 'ok', detail: this.config.dataDir },
      ...this.projectFiles.health(),
      this.grepSidecar.health(),
      this.hotMemory.health(),
      {
        id: 'pgvector',
        status: this.postgresDocuments ? 'ok' : 'disabled',
        detail: this.postgresDocuments
          ? `POSTGRES_URL configured; embeddingProvider=${this.config.embeddingProvider}`
          : 'POSTGRES_URL not set'
      },
      {
        id: 'sqlite',
        status: this.sqliteDocuments ? 'ok' : 'disabled',
        detail: this.sqliteDocuments
          ? `${this.config.sqlitePath}; embeddingProvider=${this.config.embeddingProvider}`
          : 'KNOWLEDGE_ESCROW_SQLITE / KNOWLEDGE_ESCROW_SQLITE_PATH not set'
      }
    ];
  }

  private async recordMetric(metric: Omit<MemoryOperationMetric, 'id' | 'createdAt'>): Promise<void> {
    try {
      await this.metrics.record(metric);
    } catch (error) {
      const warning = `observability write skipped: ${error instanceof Error ? error.message : String(error)}`;
      if (!this.observabilityWarnings.includes(warning)) this.observabilityWarnings.push(warning);
    }
  }

  private async recordFailure(method: MemoryOperationName, startedAt: number, error: unknown): Promise<void> {
    await this.recordMetric({
      method,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorType: error instanceof Error ? error.name : 'UnknownError'
    });
  }
}

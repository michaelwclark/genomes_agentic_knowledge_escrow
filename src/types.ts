export type MemoryKind =
  | 'PROJECT_RULE'
  | 'USER_PREF'
  | 'FEATURE_STATE'
  | 'AGENT_TRACE'
  | 'FACT'
  | 'CROSS_FEATURE_LEARNING'
  | 'EPHEMERAL';

export type MemorySubstrate =
  | 'jsonl'
  | 'project_memory'
  | 'user_memory'
  | 'feature_worklog'
  | 'agent_trace'
  | 'grep_sidecar'
  | 'hot_memory'
  | 'pgvector'
  | 'sqlite';

export interface MemoryScope {
  project?: string;
  feature?: number;
  phase?: string;
  persona?: string;
  source?: string;
  sessionId?: string;
}

export interface MemoryClassification {
  kind: MemoryKind;
  title: string;
  scope: MemoryScope;
  substrates: MemorySubstrate[];
  confidence: number;
}

export interface MemoryWriteInput {
  content: string;
  scope?: MemoryScope;
  kindHint?: MemoryKind;
}

export interface MemoryReadInput {
  query: string;
  project?: string;
  feature?: number;
  phase?: string;
  limit?: number;
}

export interface MemoryRecord {
  id: string;
  op: 'write' | 'forget' | 'link' | 'import';
  content?: string;
  contentHash?: string;
  kind?: MemoryKind;
  title?: string;
  scope: MemoryScope;
  substrates: MemorySubstrate[];
  status: 'committed' | 'skipped-dup' | 'tombstoned' | 'shadow';
  deduped?: boolean;
  provenance?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryHit {
  substrate: MemorySubstrate;
  id: string;
  path: string;
  title: string;
  confidence: number;
  scope: MemoryScope;
  content: string;
  kind?: MemoryKind;
}

export interface LayerHealth {
  id: string;
  status: 'ok' | 'disabled' | 'error';
  detail?: string;
}

export interface MemoryWriteResult {
  kind: MemoryKind;
  scope: MemoryScope;
  deduped: boolean;
  recordId: string;
  writes: Array<{ substrate: MemorySubstrate; path: string }>;
  warnings?: string[];
}

export interface ForgetInput {
  opId?: string;
  contentHash?: string;
}

export interface LinkInput {
  fromOpId: string;
  toOpId: string;
  relation: string;
}

export type MemoryOperationName = 'read' | 'write' | 'forget' | 'link';

export interface MemoryOperationMetric {
  id: string;
  createdAt: string;
  method: MemoryOperationName;
  durationMs: number;
  ok: boolean;
  resultCount?: number;
  warningCount?: number;
  deduped?: boolean;
  substrateHits?: Record<string, number>;
  substrateSkips?: Record<string, number>;
  errorType?: string;
}

export interface AnalyticsMethodRollup {
  count: number;
  errors: number;
  errorRate: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export interface AnalyticsSummary {
  source: 'local';
  generatedAt: string;
  windowHours: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  operations: number;
  errors: number;
  errorRate: number;
  warnings: number;
  reads: number;
  readsWithHits: number;
  readHitRate: number;
  zeroHitRate: number;
  writes: number;
  dedupedWrites: number;
  dedupeRate: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  substrateHits: Record<string, number>;
  substrateSkips: Record<string, number>;
  methods: Record<MemoryOperationName, AnalyticsMethodRollup>;
  warningsDetail?: string[];
}

export interface MetricsHealth {
  status: 'ok' | 'stale' | 'disabled' | 'error';
  path: string;
  bytes?: number;
  eventCount: number;
  lastEventAt: string | null;
  stale: boolean;
  detail?: string;
}

export interface BrainConfig {
  dataDir: string;
  projectRoot?: string;
  /** Explicit name=path registry for project MEMORY.md routing outside the OS tree. */
  projectRoots: Record<string, string>;
  userMemoryRoot?: string;
  hotMemoryDirs: string[];
  hotMemoryHours: number;
  /** Days that hook-copied session transcripts are kept under `<dataDir>/ingest`. Default 14. */
  ingestRetentionDays?: number;
  grepRoots: string[];
  enableWrites: boolean;
  metricsEnabled: boolean;
  metricsRetentionDays: number;
  /** Timestamped backup directories kept under `backups/` after each backup() call. */
  backupRetentionCount: number;
  /** Days after which safely-prunable ledger rows (dedupe skips, forgotten
   * write + forget pairs) are compacted out of memory_ops.jsonl. */
  ledgerRetentionDays: number;
  healthFreshnessMinutes: number;
  httpHost: string;
  httpPort: number;
  /** Optional Postgres/pgvector add-on; off unless POSTGRES_URL is set. */
  postgresUrl?: string;
  /** Resolved path to the local SQLite document store, when enabled. */
  sqlitePath?: string;
  /** When false, disables write-time PII redaction. Default on. */
  redactionEnabled: boolean;
  /** User-specific extra detectors parsed from KNOWLEDGE_ESCROW_REDACTION_PATTERNS. */
  redactionPatterns: Array<{ name: string; pattern: RegExp }>;
  embeddingProvider: 'none' | 'deterministic' | 'ollama' | 'local';
  ollamaUrl: string;
  ollamaModel: string;
  /** Directory holding the local static-embedding model's `model.safetensors`
   * and `tokenizer.json`, used when embeddingProvider is 'local'. */
  localModelDir?: string;
  /** Overrides the MCP serverInfo.name reported to clients (e.g. the Codex
   * plugin reports 'knowledge-escrow' instead of the base server's name). */
  serverName?: string;
}

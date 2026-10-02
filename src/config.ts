import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { BrainConfig } from './types.js';

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Single place in the codebase that reads KNOWLEDGE_ESCROW_* environment
 * variables. Falls back to the legacy GENOMES_BRAIN_* name for anyone
 * upgrading from the private predecessor project, so an existing install
 * keeps working unmodified. New configuration should only ever add a key
 * here, never read `process.env` directly elsewhere. */
function readEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`KNOWLEDGE_ESCROW_${suffix}`] ?? env[`GENOMES_BRAIN_${suffix}`];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const dataDir = expandHome(readEnv(env, 'DATA_DIR') ?? '~/.knowledge-escrow');
  const projectRoot = readEnv(env, 'PROJECT_ROOT') ? expandHome(readEnv(env, 'PROJECT_ROOT') as string) : undefined;
  const userMemoryRoot = readEnv(env, 'USER_MEMORY_ROOT')
    ? expandHome(readEnv(env, 'USER_MEMORY_ROOT') as string)
    : undefined;
  const hotMemoryDirs = splitPaths(readEnv(env, 'HOT_MEMORY_DIRS')).map(expandHome);
  const grepRoots = splitPaths(readEnv(env, 'GREP_ROOTS')).map(expandHome);

  return {
    dataDir,
    projectRoot,
    projectRoots: parseProjectRoots(readEnv(env, 'PROJECT_ROOTS')),
    userMemoryRoot,
    hotMemoryDirs,
    hotMemoryHours: Number(readEnv(env, 'HOT_MEMORY_HOURS') ?? '72'),
    grepRoots,
    enableWrites: readEnv(env, 'ENABLE_WRITES') !== '0',
    metricsEnabled: readEnv(env, 'METRICS_ENABLED') !== '0',
    metricsRetentionDays: Number(readEnv(env, 'METRICS_RETENTION_DAYS') ?? '30'),
    backupRetentionCount: Number(readEnv(env, 'BACKUP_RETENTION_COUNT') ?? '5'),
    ledgerRetentionDays: Number(readEnv(env, 'LEDGER_RETENTION_DAYS') ?? '90'),
    healthFreshnessMinutes: Number(readEnv(env, 'HEALTH_FRESHNESS_MINUTES') ?? '1440'),
    httpHost: readEnv(env, 'HTTP_HOST') ?? '127.0.0.1',
    httpPort: Number(readEnv(env, 'HTTP_PORT') ?? '3155'),
    // Optional Postgres/pgvector add-on; off unless POSTGRES_URL is set.
    postgresUrl: env['POSTGRES_URL'],
    sqlitePath: resolveSqlitePath(env, dataDir),
    // Off by default: redaction changes stored content, so an existing
    // install must opt in explicitly. The Codex plugin opts in via
    // KNOWLEDGE_ESCROW_REDACTION=1 in its own mcp.json.
    redactionEnabled: readEnv(env, 'REDACTION') === '1',
    redactionPatterns: parseRedactionPatterns(readEnv(env, 'REDACTION_PATTERNS')),
    embeddingProvider: parseEmbeddingProvider(readEnv(env, 'EMBEDDING_PROVIDER')),
    ollamaUrl: readEnv(env, 'OLLAMA_URL') ?? 'http://127.0.0.1:11434',
    ollamaModel: readEnv(env, 'OLLAMA_MODEL') ?? 'nomic-embed-text',
    localModelDir: readEnv(env, 'LOCAL_MODEL_DIR') ? expandHome(readEnv(env, 'LOCAL_MODEL_DIR') as string) : undefined,
    serverName: readEnv(env, 'SERVER_NAME')
  };
}

function parseEmbeddingProvider(value?: string): BrainConfig['embeddingProvider'] {
  if (value === 'deterministic' || value === 'ollama' || value === 'local') return value;
  return 'none';
}

function resolveSqlitePath(env: NodeJS.ProcessEnv, dataDir: string): string | undefined {
  const explicitPath = readEnv(env, 'SQLITE_PATH');
  if (explicitPath) return expandHome(explicitPath);
  if (readEnv(env, 'SQLITE') === '1') return path.join(dataDir, 'escrow.sqlite');
  return undefined;
}

/** Parses user-specific extra detector patterns (e.g. an account-number
 * shape unique to one person's own documents). Invalid entries are skipped
 * with a stderr warning rather than crashing config load. */
function parseRedactionPatterns(value?: string): Array<{ name: string; pattern: RegExp }> {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    console.error(`KNOWLEDGE_ESCROW_REDACTION_PATTERNS is not valid JSON; ignoring: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('KNOWLEDGE_ESCROW_REDACTION_PATTERNS must be a JSON array; ignoring');
    return [];
  }
  const patterns: Array<{ name: string; pattern: RegExp }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, regex, flags } = entry as { name?: unknown; regex?: unknown; flags?: unknown };
    if (typeof name !== 'string' || !name.trim() || typeof regex !== 'string') {
      console.error(`KNOWLEDGE_ESCROW_REDACTION_PATTERNS entry missing name/regex; ignoring: ${JSON.stringify(entry)}`);
      continue;
    }
    try {
      const pattern = new RegExp(regex, typeof flags === 'string' ? flags : 'g');
      patterns.push({ name, pattern });
    } catch (error) {
      console.error(`KNOWLEDGE_ESCROW_REDACTION_PATTERNS entry "${name}" has an invalid regex; ignoring: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return patterns;
}

function parseProjectRoots(value?: string): Record<string, string> {
  if (!value) return {};
  const roots: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const dir = expandHome(trimmed.slice(eq + 1).trim());
    if (name && dir) roots[name] = dir;
  }
  return roots;
}

function splitPaths(value?: string): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadDotEnv(file = path.resolve(process.cwd(), '.env'), env: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key] !== undefined) continue;
    env[key] = unquote(rawValue.trim());
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

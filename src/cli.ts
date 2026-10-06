#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { loadConfig, loadDotEnv } from './config.js';
import { MemoryRouter } from './router.js';
import { startHttpServer, startStdioServer } from './mcp/server.js';
import { runStdioHttpProxy } from './mcp/stdio-http-proxy.js';
import { callTool } from './mcp/json-rpc.js';
import { loadJsonlSessionMemories, previewJsonlSessions } from './importers/session-importer.js';
import { loadMemoryJsonl, previewMemoryJsonl } from './importers/jsonl-importer.js';
import { renderAnalyticsMarkdown } from './observability.js';
import { SERVICE_VERSION } from './version.js';
import { runHook } from './hooks.js';

loadDotEnv();
const config = loadConfig();
let router: MemoryRouter;

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'doctor':
      await runFinite(async () => {
        const ok = await doctor(args.includes('--check-db'));
        if (!ok) process.exitCode = 1;
      });
      return;
    case 'health':
      await runFinite(() => runHealth(args));
      return;
    case 'analytics':
    case 'metrics':
      await runFinite(() => runAnalytics(args));
      return;
    case 'report':
      await runFinite(() => runReport(args));
      return;
    case 'mcp':
      startStdioServer(router);
      return;
    case 'serve-http': {
      const server = startHttpServer(router, config.httpHost, config.httpPort);
      await waitForListening(server);
      console.error(`Knowledge Escrow HTTP MCP listening on http://${config.httpHost}:${config.httpPort}/mcp`);
      await new Promise<void>((resolve) => server.once('close', resolve));
      await router.close();
      return;
    }
    case 'read':
      await runFinite(async () => {
        console.log(
          JSON.stringify(
            await callTool(router, 'memory_read', {
              query: positionalArgs(args).join(' '),
              project: readFlag(args, '--project'),
              feature: readNumberFlag(args, '--feature'),
              phase: readFlag(args, '--phase'),
              limit: readNumberFlag(args, '--limit')
            }),
            null,
            2
          )
        );
      });
      return;
    case 'write':
      await runFinite(async () => {
        console.log(
          JSON.stringify(
            await callTool(router, 'memory_write', {
              content: positionalArgs(args).join(' '),
              project: readFlag(args, '--project'),
              feature: readNumberFlag(args, '--feature'),
              phase: readFlag(args, '--phase'),
              persona: readFlag(args, '--persona'),
              kindHint: readFlag(args, '--kind') ?? readFlag(args, '--kindHint')
            }),
            null,
            2
          )
        );
      });
      return;
    case 'forget':
      await runFinite(async () => {
        console.log(
          JSON.stringify(
            await callTool(router, 'memory_forget', {
              opId: readFlag(args, '--op-id') ?? readFlag(args, '--opId'),
              contentHash: readFlag(args, '--content-hash') ?? readFlag(args, '--contentHash')
            }),
            null,
            2
          )
        );
      });
      return;
    case 'link':
      await runFinite(async () => {
        console.log(
          JSON.stringify(
            await callTool(router, 'memory_link', {
              fromOpId: readFlag(args, '--from') ?? readFlag(args, '--from-op-id') ?? readFlag(args, '--fromOpId'),
              toOpId: readFlag(args, '--to') ?? readFlag(args, '--to-op-id') ?? readFlag(args, '--toOpId'),
              relation: readFlag(args, '--relation') ?? 'related'
            }),
            null,
            2
          )
        );
      });
      return;
    case 'backup':
      await runFinite(async () => {
        console.log(JSON.stringify(await router.backup(args[0]), null, 2));
      });
      return;
    case 'ledger':
      await runFinite(() => runLedger(args));
      return;
    case 'import':
      await runFinite(() => runImport(args));
      return;
    case 'backfill':
      await runFinite(() => runBackfill(args));
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function waitForListening(server: import('node:http').Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

async function runFinite(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } finally {
    await router.close();
  }
}

async function doctor(checkDb: boolean): Promise<boolean> {
  const health = await router.healthReport(checkDb);
  console.log(JSON.stringify({ ...health, http: { host: config.httpHost, port: config.httpPort } }, null, 2));
  return health.ok;
}

async function runHealth(args: string[]): Promise<void> {
  const health = await router.healthReport(args.includes('--check-db'));
  const format = readFlag(args, '--format') ?? 'json';
  console.log(format === 'markdown' ? formatHealthMarkdown(health) : JSON.stringify(health, null, 2));
  if (!health.ok) process.exitCode = 1;
}

async function runAnalytics(args: string[]): Promise<void> {
  const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'summary';
  const hours = readNumberFlag(args, '--hours') ?? 24;
  const format = readFlag(args, '--format') ?? 'json';
  if (mode === 'recent') {
    console.log(JSON.stringify(await router.recentMetrics(readNumberFlag(args, '--limit') ?? 20), null, 2));
    return;
  }
  if (mode === 'prune') {
    console.log(JSON.stringify(await router.pruneMetrics(readNumberFlag(args, '--days') ?? config.metricsRetentionDays), null, 2));
    return;
  }
  if (mode !== 'summary' && mode !== 'methods') {
    throw new Error('Usage: escrow analytics summary|recent|methods|prune [--hours 24] [--limit 20] [--format json|markdown|prometheus]');
  }
  const summary = await router.analytics(hours);
  if (mode === 'methods') {
    console.log(JSON.stringify({ source: summary.source, windowHours: summary.windowHours, methods: summary.methods }, null, 2));
    return;
  }
  if (format === 'markdown') {
    console.log(renderAnalyticsMarkdown(summary));
  } else if (format === 'prometheus') {
    console.log(await router.getMetricsStore().prometheus(hours));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

async function runLedger(args: string[]): Promise<void> {
  const mode = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  if (mode !== 'prune') {
    throw new Error('Usage: escrow ledger prune [--days 90]');
  }
  console.log(JSON.stringify(await router.pruneLedger(readNumberFlag(args, '--days') ?? config.ledgerRetentionDays), null, 2));
}

async function runReport(args: string[]): Promise<void> {
  const hours = readNumberFlag(args, '--hours') ?? 24;
  const format = readFlag(args, '--format') ?? 'markdown';
  const [health, analytics] = await Promise.all([
    router.healthReport(args.includes('--check-db')),
    router.analytics(hours)
  ]);
  const output = format === 'json'
    ? JSON.stringify({ health, analytics }, null, 2)
    : `${formatHealthMarkdown(health)}\n${renderAnalyticsMarkdown(analytics)}`;
  const outputPath = readFlag(args, '--output');
  if (outputPath) {
    await writeFile(outputPath, output, 'utf8');
    console.log(JSON.stringify({ output: outputPath, format, status: health.status }, null, 2));
  } else {
    console.log(output);
  }
  if (!health.ok) process.exitCode = 1;
}

function formatHealthMarkdown(health: Awaited<ReturnType<MemoryRouter['healthReport']>>): string {
  const layerRows = health.layers
    .map((layer) => `| ${layer.id} | ${layer.status} | ${layer.detail ?? ''} |`)
    .join('\n');
  const findings = health.findings.length ? health.findings.map((finding) => `- ${finding}`).join('\n') : '- None';
  return `# Knowledge Escrow Health

- Generated: ${health.generatedAt}
- Status: ${health.status}
- Version: ${health.version}
- Uptime: ${health.uptimeSeconds} seconds
- Active memory records: ${health.store.activeRecords}
- Metrics events: ${health.metrics.eventCount}
- Last metric: ${health.metrics.lastEventAt ?? 'none'}

## Findings

${findings}

## Layers

| Layer | Status | Detail |
| --- | --- | --- |
${layerRows}
`;
}

async function runImport(args: string[]): Promise<void> {
  const kind = args[0];
  const dryRun = args.includes('--dry-run');
  if (kind !== 'codex' && kind !== 'claude') {
    if (kind === 'jsonl') {
      await runJsonlImport(args.slice(1), dryRun);
      return;
    }
    throw new Error('Usage: escrow import codex|claude|jsonl <source> [--dry-run]');
  }
  const source =
    firstPositional(args.slice(1)) ??
    (kind === 'codex' ? process.env['CODEX_SESSIONS_DIR'] : process.env['CLAUDE_PROJECTS_DIR']) ??
    (kind === 'codex' ? '~/.codex/sessions' : '~/.claude/projects');
  const limit = Number(readFlag(args, '--limit') ?? '500');
  const preview = await previewJsonlSessions(source);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, source, limit, preview }, null, 2));
    return;
  }
  const backup = await router.backup();
  const records = await loadJsonlSessionMemories(source, limit);
  const result = await router.getStore().importRecords(records);
  console.log(JSON.stringify({ source, limit, backup, preview, result }, null, 2));
}

async function runJsonlImport(args: string[], dryRun: boolean): Promise<void> {
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('JSONL import requires a file path.');
  const limit = Number(readFlag(args, '--limit') ?? '1000');
  const preview = await previewMemoryJsonl(file);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, source: file, limit, preview }, null, 2));
    return;
  }
  const backup = await router.backup();
  const records = await loadMemoryJsonl(file, limit);
  const result = await router.getStore().importRecords(records);
  console.log(JSON.stringify({ source: file, limit, backup, preview, result }, null, 2));
}

async function runBackfill(args: string[]): Promise<void> {
  const target = args[0];
  if (target === 'sqlite') {
    await runSqliteReindex(args.slice(1));
    return;
  }
  if (target !== 'pgvector') {
    throw new Error('Usage: escrow backfill pgvector|sqlite [--limit 1000] [--batch-size 100] [--dry-run]');
  }
  const postgres = router.getPostgresDocumentStore();
  if (!postgres) throw new Error('pgvector backfill requires POSTGRES_URL.');
  if (config.embeddingProvider === 'none') {
    throw new Error('pgvector backfill requires KNOWLEDGE_ESCROW_EMBEDDING_PROVIDER=ollama or deterministic.');
  }
  const limit = readNumberFlag(args, '--limit') ?? Number.MAX_SAFE_INTEGER;
  const batchSize = readNumberFlag(args, '--batch-size') ?? 100;
  const dryRun = args.includes('--dry-run');
  const records = (await router.getStore().activeRecordsForBackfill())
    .filter((record) => record.content?.trim())
    .slice(0, limit);
  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      target: 'pgvector',
      embeddingProvider: config.embeddingProvider,
      records: records.length,
      batchSize,
      existingDocuments: await postgres.countDocuments()
    }, null, 2));
    return;
  }

  const startedAt = Date.now();
  let upserted = 0;
  let skipped = 0;
  let batches = 0;
  for (let index = 0; index < records.length; index += batchSize) {
    const batch = records.slice(index, index + batchSize);
    const missing = await postgres.missingRecords(batch);
    skipped += batch.length - missing.length;
    const result = await postgres.upsertMemories(missing);
    upserted += result.upserted;
    skipped += result.skipped;
    batches += 1;
  }
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    target: 'pgvector',
    embeddingProvider: config.embeddingProvider,
    records: records.length,
    batches,
    batchSize,
    upserted,
    skipped,
    elapsedMs,
    documentsAfter: await postgres.countDocuments()
  }, null, 2));
}

async function runSqliteReindex(args: string[]): Promise<void> {
  const sqlite = router.getSqliteDocumentStore();
  if (!sqlite) throw new Error('sqlite reindex requires KNOWLEDGE_ESCROW_SQLITE=1 or KNOWLEDGE_ESCROW_SQLITE_PATH.');
  const limit = readNumberFlag(args, '--limit') ?? Number.MAX_SAFE_INTEGER;
  const dryRun = args.includes('--dry-run');
  const records = (await router.getStore().activeRecordsForBackfill())
    .filter((record) => record.content?.trim())
    .slice(0, limit);
  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      target: 'sqlite',
      embeddingProvider: config.embeddingProvider,
      records: records.length,
      existingDocuments: await sqlite.countDocuments()
    }, null, 2));
    return;
  }
  const startedAt = Date.now();
  const result = await sqlite.reindex(records);
  console.log(JSON.stringify({
    target: 'sqlite',
    embeddingProvider: config.embeddingProvider,
    records: records.length,
    upserted: result.upserted,
    skipped: result.skipped,
    elapsedMs: Date.now() - startedAt,
    documentsAfter: await sqlite.countDocuments()
  }, null, 2));
}

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = readFlag(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg.startsWith('--')) {
      if (arg?.startsWith('--')) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      i += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function printHelp(): void {
  console.log(`Knowledge Escrow

Usage:
  escrow version
  escrow hook <session-start|stop> [--harness codex|claude]
  escrow doctor
  escrow doctor --check-db
  escrow health [--check-db] [--format json|markdown]
  escrow analytics summary [--hours 24] [--format json|markdown|prometheus]
  escrow analytics recent [--limit 20]
  escrow analytics methods [--hours 24]
  escrow analytics prune [--days 30]
  escrow report [--hours 24] [--check-db] [--format markdown|json] [--output report.md]
  escrow mcp
  escrow proxy-http [--url http://127.0.0.1:3166/mcp]
  escrow serve-http
  escrow read <query>
  escrow read <query> [--project <project_slug>] [--feature 47] [--phase build] [--limit 8]
  escrow write <memory content> [--project <project_slug>] [--feature 47] [--phase build] [--persona codex] [--kind PROJECT_RULE]
  escrow forget --op-id <memory_operation_id>
  escrow forget --content-hash <normalized_content_hash>
  escrow link --from <op_id> --to <op_id> [--relation duplicates]
  escrow backup [target-dir]
  escrow ledger prune [--days 90]
  escrow import codex|claude <sessions-dir> [--limit 500] [--dry-run]
  escrow import jsonl <memory_ops.jsonl> [--limit 1000] [--dry-run]
  escrow backfill pgvector [--limit 1000] [--batch-size 100] [--dry-run]
  escrow backfill sqlite [--limit 1000] [--dry-run]

Environment:
  KNOWLEDGE_ESCROW_DATA_DIR          file-backed memory data dir, default ~/.knowledge-escrow
  KNOWLEDGE_ESCROW_PROJECT_ROOT      project tree root for MEMORY.md routing
  KNOWLEDGE_ESCROW_HOT_MEMORY_DIRS   ${process.platform === 'win32' ? ';' : ':'}-delimited recent conversation JSONL roots
  KNOWLEDGE_ESCROW_GREP_ROOTS        ${process.platform === 'win32' ? ';' : ':'}-delimited exact-search sidecar roots
  KNOWLEDGE_ESCROW_ENABLE_WRITES     set to 0 for shadow writes
  KNOWLEDGE_ESCROW_METRICS_ENABLED   set to 0 to disable privacy-safe operation metrics
  KNOWLEDGE_ESCROW_METRICS_RETENTION_DAYS  local metrics retention, default 30
  KNOWLEDGE_ESCROW_BACKUP_RETENTION_COUNT  timestamped backups kept under backups/, default 5
  KNOWLEDGE_ESCROW_LEDGER_RETENTION_DAYS  ledger dedupe/tombstone compaction age, default 90
  KNOWLEDGE_ESCROW_HEALTH_FRESHNESS_MINUTES  stale-metrics threshold, default 1440
  KNOWLEDGE_ESCROW_HTTP_HOST         default 127.0.0.1
  KNOWLEDGE_ESCROW_HTTP_PORT         default 3155
  KNOWLEDGE_ESCROW_HTTP_URL          stdio proxy target, default http://127.0.0.1:3166/mcp
  KNOWLEDGE_ESCROW_SQLITE            set to 1 to enable the local SQLite document store at <data-dir>/escrow.sqlite
  KNOWLEDGE_ESCROW_SQLITE_PATH       explicit SQLite document store path (overrides KNOWLEDGE_ESCROW_SQLITE default)
  KNOWLEDGE_ESCROW_REDACTION         set to 1 to enable write-time PII redaction (default off)
  KNOWLEDGE_ESCROW_SERVER_NAME       overrides the MCP serverInfo.name (default knowledge-escrow)
  KNOWLEDGE_ESCROW_REDACTION_PATTERNS  JSON array of user-specific {name, regex, flags?} detectors
  POSTGRES_URL                       optional Postgres/pgvector add-on, off unless set

  Every KNOWLEDGE_ESCROW_* variable above also accepts a legacy GENOMES_BRAIN_*
  name as a fallback, for anyone upgrading from the private predecessor project.
`);
}

async function entry(argv: string[]): Promise<void> {
  // Handled before any MemoryRouter/data-dir touch: the Codex plugin
  // launcher (bin/escrow) runs this as a cheap non-MCP liveness probe to
  // decide whether the packaged SEA is actually runnable (e.g. not blocked
  // by Gatekeeper/quarantine) before `exec`-ing it as the real stdio
  // server. It must never create or open a data directory as a side effect.
  if (argv[0] === 'version' || argv[0] === '--version') {
    console.log(SERVICE_VERSION);
    return;
  }
  // Hooks run inline with an agent session: handled before the router exists
  // so SessionStart stays fast and never opens SQLite or the embedding model.
  if (argv[0] === 'hook') {
    await runHook(argv.slice(1), {
      env: process.env,
      stdin: process.stdin,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text)
    });
    process.exitCode = 0;
    return;
  }
  if (argv[0] === 'proxy-http') {
    await runStdioHttpProxy({
      endpoint: readFlag(argv.slice(1), '--url') ??
        process.env['KNOWLEDGE_ESCROW_HTTP_URL'] ??
        process.env['GENOMES_BRAIN_HTTP_URL'] ??
        'http://127.0.0.1:3166/mcp'
    });
    return;
  }
  router = new MemoryRouter(config);
  await main(argv);
}

entry(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

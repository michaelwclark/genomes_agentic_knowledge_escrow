import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AnalyticsMethodRollup,
  AnalyticsSummary,
  MemoryOperationMetric,
  MemoryOperationName,
  MetricsHealth
} from './types.js';

const MAX_ANALYTICS_EVENTS = 100_000;

export class MetricsStore {
  readonly metricsPath: string;
  private lastPrunedDay?: string;
  private pruneInFlight?: Promise<{ kept: number; removed: number; cutoff: string }>;

  constructor(
    dataDir: string,
    private readonly enabled = true,
    private readonly retentionDays = 30
  ) {
    this.metricsPath = path.join(dataDir, 'metrics.jsonl');
  }

  async record(input: Omit<MemoryOperationMetric, 'id' | 'createdAt'>): Promise<MemoryOperationMetric | undefined> {
    if (!this.enabled) return undefined;
    await this.init();
    const today = new Date().toISOString().slice(0, 10);
    if (this.retentionDays > 0 && this.lastPrunedDay !== today) {
      this.lastPrunedDay = today;
      this.pruneInFlight = this.prune(this.retentionDays).catch((error) => {
        this.lastPrunedDay = undefined;
        throw error;
      });
    }
    if (this.pruneInFlight) await this.pruneInFlight;
    const event: MemoryOperationMetric = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };
    await fs.appendFile(this.metricsPath, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async summary(hours = 24): Promise<AnalyticsSummary> {
    return summarizeMetrics(await this.read({ hours }), hours, 'local');
  }

  async recent(limit = 20): Promise<MemoryOperationMetric[]> {
    const events = await this.read({ limit: Math.max(1, Math.min(limit, 500)) });
    return events.reverse();
  }

  async methods(hours = 24): Promise<Record<MemoryOperationName, AnalyticsMethodRollup>> {
    return (await this.summary(hours)).methods;
  }

  async health(freshnessMinutes: number): Promise<MetricsHealth> {
    if (!this.enabled) {
      return { status: 'disabled', path: this.metricsPath, eventCount: 0, lastEventAt: null, stale: false };
    }
    try {
      await this.init();
      const stat = await fs.stat(this.metricsPath);
      const recent = await this.recent(1);
      const lastEventAt = recent[0]?.createdAt ?? null;
      const stale = Boolean(
        lastEventAt && Date.now() - Date.parse(lastEventAt) > Math.max(1, freshnessMinutes) * 60_000
      );
      return {
        status: stale ? 'stale' : 'ok',
        path: this.metricsPath,
        bytes: stat.size,
        eventCount: await this.countLines(),
        lastEventAt,
        stale
      };
    } catch (error) {
      return {
        status: 'error',
        path: this.metricsPath,
        eventCount: 0,
        lastEventAt: null,
        stale: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async prune(days = this.retentionDays): Promise<{ kept: number; removed: number; cutoff: string }> {
    await this.init();
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
    const events = await this.read({});
    const kept = events.filter((event) => event.createdAt >= cutoff);
    await fs.writeFile(
      this.metricsPath,
      kept.length ? `${kept.map((event) => JSON.stringify(event)).join('\n')}\n` : '',
      'utf8'
    );
    return { kept: kept.length, removed: events.length - kept.length, cutoff };
  }

  async prometheus(hours = 24): Promise<string> {
    return renderPrometheus(await this.summary(hours));
  }

  private async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.metricsPath), { recursive: true });
    await fs.appendFile(this.metricsPath, '', 'utf8');
  }

  private async read(options: { hours?: number; limit?: number }): Promise<MemoryOperationMetric[]> {
    if (!this.enabled) return [];
    await this.init();
    const raw = await fs.readFile(this.metricsPath, 'utf8');
    const cutoff = options.hours
      ? Date.now() - Math.max(0, options.hours) * 3_600_000
      : Number.NEGATIVE_INFINITY;
    const parsed: MemoryOperationMetric[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as MemoryOperationMetric;
        if (Date.parse(event.createdAt) >= cutoff) parsed.push(event);
      } catch {
        // A partial or malformed line should not take down operational reporting.
      }
    }
    const limited = parsed.slice(-Math.min(options.limit ?? MAX_ANALYTICS_EVENTS, MAX_ANALYTICS_EVENTS));
    return limited;
  }

  private async countLines(): Promise<number> {
    const raw = await fs.readFile(this.metricsPath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).length;
  }
}

export function summarizeMetrics(
  events: MemoryOperationMetric[],
  hours: number,
  source: AnalyticsSummary['source']
): AnalyticsSummary {
  const methods = emptyMethodRollups();
  const substrateHits: Record<string, number> = {};
  const substrateSkips: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let reads = 0;
  let readsWithHits = 0;
  let writes = 0;
  let dedupedWrites = 0;

  for (const event of events) {
    const method = methods[event.method];
    method.count += 1;
    method.errors += event.ok ? 0 : 1;
    method.totalDurationMs += event.durationMs;
    method.durations.push(event.durationMs);
    errors += event.ok ? 0 : 1;
    warnings += event.warningCount ?? 0;
    if (event.method === 'read') {
      reads += 1;
      if ((event.resultCount ?? 0) > 0) readsWithHits += 1;
    }
    if (event.method === 'write') {
      writes += 1;
      if (event.deduped) dedupedWrites += 1;
    }
    for (const [substrate, count] of Object.entries(event.substrateHits ?? {})) {
      substrateHits[substrate] = (substrateHits[substrate] ?? 0) + count;
    }
    for (const [substrate, count] of Object.entries(event.substrateSkips ?? {})) {
      substrateSkips[substrate] = (substrateSkips[substrate] ?? 0) + count;
    }
  }

  const finalized = Object.fromEntries(
    Object.entries(methods).map(([method, value]) => [
      method,
      {
        count: value.count,
        errors: value.errors,
        errorRate: ratio(value.errors, value.count),
        averageDurationMs: value.count ? round(value.totalDurationMs / value.count) : 0,
        p50DurationMs: percentile(value.durations, 0.5),
        p95DurationMs: percentile(value.durations, 0.95)
      }
    ])
  ) as Record<MemoryOperationName, AnalyticsMethodRollup>;

  const durations = events.map((event) => event.durationMs);
  return {
    source,
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    firstEventAt: events[0]?.createdAt ?? null,
    lastEventAt: events.at(-1)?.createdAt ?? null,
    operations: events.length,
    errors,
    errorRate: ratio(errors, events.length),
    warnings,
    reads,
    readsWithHits,
    readHitRate: ratio(readsWithHits, reads),
    zeroHitRate: ratio(reads - readsWithHits, reads),
    writes,
    dedupedWrites,
    dedupeRate: ratio(dedupedWrites, writes),
    averageDurationMs: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    substrateHits,
    substrateSkips,
    methods: finalized
  };
}

export function renderAnalyticsMarkdown(summary: AnalyticsSummary): string {
  const methodRows = Object.entries(summary.methods)
    .filter(([, rollup]) => rollup.count > 0)
    .map(([method, rollup]) =>
      `| ${method} | ${rollup.count} | ${formatPercent(rollup.errorRate)} | ${rollup.averageDurationMs} | ${rollup.p95DurationMs} |`
    )
    .join('\n');
  const substrateRows = Object.entries(summary.substrateHits)
    .sort((a, b) => b[1] - a[1])
    .map(([substrate, count]) => `| ${substrate} | ${count} |`)
    .join('\n');
  return `# Knowledge Escrow Analytics

- Generated: ${summary.generatedAt}
- Source: ${summary.source}
- Window: ${summary.windowHours} hours
- Operations: ${summary.operations}
- Error rate: ${formatPercent(summary.errorRate)}
- Read hit rate: ${formatPercent(summary.readHitRate)}
- Write dedupe rate: ${formatPercent(summary.dedupeRate)}
- Latency p50 / p95: ${summary.p50DurationMs} ms / ${summary.p95DurationMs} ms

## Methods

| Method | Count | Error rate | Avg ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
${methodRows || '| No events | 0 | 0% | 0 | 0 |'}

## Substrate Hits

| Substrate | Hits |
| --- | ---: |
${substrateRows || '| No hits | 0 |'}
`;
}

export function renderPrometheus(summary: AnalyticsSummary): string {
  const lines = [
    '# HELP genomes_brain_operations_total Memory operations observed in the reporting window.',
    '# TYPE genomes_brain_operations_total gauge',
    `genomes_brain_operations_total ${summary.operations}`,
    '# HELP genomes_brain_errors_total Failed memory operations in the reporting window.',
    '# TYPE genomes_brain_errors_total gauge',
    `genomes_brain_errors_total ${summary.errors}`,
    '# HELP genomes_brain_read_hit_ratio Fraction of reads returning at least one hit.',
    '# TYPE genomes_brain_read_hit_ratio gauge',
    `genomes_brain_read_hit_ratio ${summary.readHitRate}`,
    '# HELP genomes_brain_write_dedupe_ratio Fraction of writes deduplicated.',
    '# TYPE genomes_brain_write_dedupe_ratio gauge',
    `genomes_brain_write_dedupe_ratio ${summary.dedupeRate}`,
    '# HELP genomes_brain_operation_duration_ms Operation latency percentiles.',
    '# TYPE genomes_brain_operation_duration_ms gauge',
    `genomes_brain_operation_duration_ms{quantile="0.5"} ${summary.p50DurationMs}`,
    `genomes_brain_operation_duration_ms{quantile="0.95"} ${summary.p95DurationMs}`
  ];
  for (const [method, rollup] of Object.entries(summary.methods)) {
    lines.push(`genomes_brain_method_operations_total{method="${method}"} ${rollup.count}`);
    lines.push(`genomes_brain_method_errors_total{method="${method}"} ${rollup.errors}`);
  }
  for (const [substrate, hits] of Object.entries(summary.substrateHits)) {
    lines.push(`genomes_brain_substrate_hits_total{substrate="${escapeLabel(substrate)}"} ${hits}`);
  }
  return `${lines.join('\n')}\n`;
}

function emptyMethodRollups(): Record<
  MemoryOperationName,
  { count: number; errors: number; totalDurationMs: number; durations: number[] }
> {
  const empty = () => ({ count: 0, errors: 0, totalDurationMs: 0, durations: [] as number[] });
  return {
    read: empty(),
    write: empty(),
    forget: empty(),
    link: empty()
  };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[Math.max(0, index)] ?? 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

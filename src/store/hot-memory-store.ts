import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrainConfig, LayerHealth, MemoryHit, MemoryReadInput } from '../types.js';
import { readSmallTextFile, walkFiles } from './fs-utils.js';
import { scoreText } from './scoring.js';

export class HotMemoryStore {
  constructor(
    private readonly dirs: string[],
    private readonly hours: number
  ) {}

  static fromConfig(config: BrainConfig): HotMemoryStore {
    return new HotMemoryStore(config.hotMemoryDirs, config.hotMemoryHours);
  }

  async read(input: MemoryReadInput): Promise<MemoryHit[]> {
    if (!this.dirs.length) return [];
    const cutoff = Date.now() - this.hours * 60 * 60 * 1000;
    const files = await walkFiles(this.dirs, (file) => file.endsWith('.jsonl') || file.endsWith('.json'), {
      maxFiles: 500,
      maxDirs: 3000
    });
    const recentFiles: string[] = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= cutoff) recentFiles.push(file);
      } catch {
        continue;
      }
    }

    const hits: MemoryHit[] = [];
    for (const file of recentFiles) {
      const raw = await readSmallTextFile(file, 10 * 1024 * 1024);
      if (!raw) continue;
      const lines = raw.trim().startsWith('{') && !raw.includes('\n') ? [raw] : raw.split(/\r?\n/).filter(Boolean);
      for (let index = Math.max(0, lines.length - 1000); index < lines.length; index += 1) {
        const line = lines[index] as string;
        const text = extractUsefulText(line);
        if (!text) continue;
        const score = scoreText(input.query, `${file} ${text}`);
        if (score <= 0 && input.query.trim()) continue;
        hits.push({
          substrate: 'hot_memory',
          id: stableId(`${file}:${index}:${text}`),
          path: file,
          title: `${path.basename(file)}:${index + 1}`,
          confidence: Math.max(0.01, Math.min(1, score * 0.96)),
          scope: { project: input.project, source: 'hot-memory' },
          content: text
        });
      }
    }
    return hits;
  }

  health(): LayerHealth {
    return {
      id: 'hot_memory',
      status: this.dirs.length ? 'ok' : 'disabled',
      detail: this.dirs.length
        ? `${this.hours}h window over ${this.dirs.join(', ')}`
        : 'KNOWLEDGE_ESCROW_HOT_MEMORY_DIRS not set'
    };
  }
}

function extractUsefulText(line: string): string | undefined {
  try {
    return extractFromValue(JSON.parse(line))?.replace(/\s+/g, ' ').trim().slice(0, 2000);
  } catch {
    return line.replace(/\s+/g, ' ').trim().slice(0, 2000) || undefined;
  }
}

function extractFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => extractFromValue(item, depth + 1))
      .filter(Boolean)
      .join(' ')
      .trim() || undefined;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'message', 'summary', 'prompt', 'response']) {
      const extracted = extractFromValue(object[key], depth + 1);
      if (extracted) return extracted;
    }
    if (typeof object['type'] === 'string' && typeof object['role'] === 'string') {
      const extracted = extractFromValue(object['payload'] ?? object['data'], depth + 1);
      if (extracted) return extracted;
    }
    return Object.values(object)
      .map((item) => extractFromValue(item, depth + 1))
      .filter(Boolean)
      .join(' ')
      .trim() || undefined;
  }
  return undefined;
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

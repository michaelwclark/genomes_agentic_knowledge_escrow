import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BrainConfig, LayerHealth, MemoryHit, MemoryReadInput } from '../types.js';
import { isTextMemoryFile, readSmallTextFile, splitTextChunks, walkFiles } from './fs-utils.js';
import { scoreText } from './scoring.js';

export class GrepSidecarStore {
  private readonly roots: string[];

  constructor(config: BrainConfig) {
    this.roots = config.grepRoots.length ? config.grepRoots : config.projectRoot ? [config.projectRoot] : [];
  }

  async read(input: MemoryReadInput): Promise<MemoryHit[]> {
    if (!this.roots.length) return [];
    const files = await walkFiles(this.roots, isTextMemoryFile, { maxFiles: 700, maxDirs: 8000 });
    const hits: MemoryHit[] = [];
    for (const file of files) {
      const raw = await readSmallTextFile(file);
      if (!raw) continue;
      const chunks = splitTextChunks(raw, 80);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] as string;
        const score = scoreText(input.query, `${file} ${chunk}`);
        if (score <= 0 && input.query.trim()) continue;
        if (input.project && !file.includes(input.project) && !chunk.includes(input.project)) continue;
        hits.push({
          substrate: 'grep_sidecar',
          id: stableId(`${file}:${index}:${chunk}`),
          path: file,
          title: `${path.basename(file)}:${index + 1}`,
          confidence: Math.max(0.01, Math.min(1, score * 0.92)),
          scope: { project: input.project, source: 'grep-sidecar' },
          content: chunk
        });
      }
    }
    return hits;
  }

  health(): LayerHealth {
    return {
      id: 'grep_sidecar',
      status: this.roots.length ? 'ok' : 'disabled',
      detail: this.roots.length ? this.roots.join(', ') : 'KNOWLEDGE_ESCROW_GREP_ROOTS or KNOWLEDGE_ESCROW_PROJECT_ROOT not set'
    };
  }
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

import fs from 'node:fs/promises';
import type { ImportedMemory, ImportPreview } from './session-importer.js';
import type { MemoryKind } from '../types.js';

export async function previewMemoryJsonl(file: string): Promise<ImportPreview> {
  const stat = await fs.stat(file);
  const raw = await fs.readFile(file, 'utf8');
  return {
    files: 1,
    records: raw.split(/\r?\n/).filter(Boolean).length,
    bytes: stat.size,
    newest: stat.mtime.toISOString()
  };
}

export async function loadMemoryJsonl(file: string, maxRecords = 1000): Promise<ImportedMemory[]> {
  const raw = await fs.readFile(file, 'utf8');
  const records: ImportedMemory[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    if (records.length >= maxRecords) break;
    const parsed = JSON.parse(line) as {
      content?: unknown;
      kind?: unknown;
      title?: unknown;
      scope?: Record<string, unknown>;
      id?: unknown;
    };
    if (typeof parsed.content !== 'string' || !parsed.content.trim()) continue;
    records.push({
      content: parsed.content,
      kindHint: validKind(parsed.kind) ? parsed.kind : undefined,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : undefined,
      source: file,
      scope: {
        source: 'memory-jsonl',
        project: typeof parsed.scope?.['project'] === 'string' ? parsed.scope['project'] : undefined,
        phase: typeof parsed.scope?.['phase'] === 'string' ? parsed.scope['phase'] : undefined,
        sessionId: typeof parsed.id === 'string' ? parsed.id : undefined
      }
    });
  }
  return records;
}

function validKind(kind: unknown): kind is MemoryKind {
  return (
    typeof kind === 'string' &&
    [
      'PROJECT_RULE',
      'USER_PREF',
      'FEATURE_STATE',
      'AGENT_TRACE',
      'FACT',
      'CROSS_FEATURE_LEARNING',
      'EPHEMERAL'
    ].includes(kind)
  );
}


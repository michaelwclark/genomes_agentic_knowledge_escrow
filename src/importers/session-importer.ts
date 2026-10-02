import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ImportPreview {
  files: number;
  records: number;
  bytes: number;
  newest?: string;
}

export interface ImportedMemory {
  content: string;
  source: string;
  /** Display title; falls back to source when absent. */
  title?: string;
  kindHint?: import('../types.js').MemoryKind;
  scope: { source: string; sessionId?: string; project?: string; phase?: string };
}

export async function previewJsonlSessions(sourceDir: string): Promise<ImportPreview> {
  const files = await findJsonlFiles(expandHome(sourceDir));
  let records = 0;
  let bytes = 0;
  let newest: string | undefined;
  for (const file of files) {
    const stat = await fs.stat(file);
    bytes += stat.size;
    if (!newest || stat.mtime.toISOString() > newest) newest = stat.mtime.toISOString();
    const raw = await fs.readFile(file, 'utf8');
    records += raw.split(/\r?\n/).filter(Boolean).length;
  }
  return { files: files.length, records, bytes, newest };
}

export async function loadJsonlSessionMemories(sourceDir: string, maxRecords = 500): Promise<ImportedMemory[]> {
  const files = await findJsonlFiles(expandHome(sourceDir));
  const memories: ImportedMemory[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      if (memories.length >= maxRecords) return memories;
      const text = extractUsefulText(line);
      if (!text) continue;
      memories.push({
        content: text,
        source: file,
        scope: { source: 'conversation-log', sessionId: path.basename(file, '.jsonl') }
      });
    }
  }
  return memories;
}

function extractUsefulText(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const candidates = [
      parsed['message'],
      parsed['text'],
      parsed['content'],
      parsed['payload'],
      parsed['response_item']
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 80) return candidate.trim();
      if (candidate && typeof candidate === 'object') {
        const serialized = JSON.stringify(candidate);
        if (serialized.length > 120) return serialized;
      }
    }
  } catch {
    if (line.length > 120) return line;
  }
  return undefined;
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

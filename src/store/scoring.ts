import type { MemoryHit, MemoryRecord } from '../types.js';

export function scoreText(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0.1;
  const haystack = text.toLowerCase();
  const terms = normalizedQuery
    .split(/[^a-z0-9_'-]+/)
    .filter((term) => term.length > 1);
  if (!terms.length) return 0;
  const hits = terms.filter((term) => haystack.includes(term)).length;
  const phraseBonus = haystack.includes(normalizedQuery) ? 0.35 : 0;
  return Math.max(0, Math.min(1, hits / terms.length + phraseBonus));
}

export function scoreRecord(record: MemoryRecord, query: string): number {
  return scoreText(
    query,
    `${record.title ?? ''} ${record.kind ?? ''} ${JSON.stringify(record.scope)} ${record.content ?? ''}`
  );
}

export function dedupeHits(hits: MemoryHit[]): MemoryHit[] {
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  for (const hit of hits) {
    const key = `${hit.substrate}:${hit.id}:${hit.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

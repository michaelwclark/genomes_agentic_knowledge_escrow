import { createHash } from 'node:crypto';

export function normalizeContent(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeContent(text)).digest('hex');
}


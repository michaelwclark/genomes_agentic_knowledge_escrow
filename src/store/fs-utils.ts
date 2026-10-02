import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SKIP_DIRS = new Set([
  '.brain',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '__pycache__',
  'dist',
  'node_modules',
  'vendor'
]);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMarkdownFile(filePath: string, title: string): Promise<void> {
  if (await pathExists(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `# ${title}\n`, 'utf8');
}

export async function walkFiles(
  roots: string[],
  predicate: (filePath: string) => boolean,
  options: { maxFiles?: number; maxDirs?: number; skipDirs?: Set<string> } = {}
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 500;
  const maxDirs = options.maxDirs ?? 5000;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const files: string[] = [];
  const stack = roots.slice().reverse();
  let visitedDirs = 0;

  while (stack.length && files.length < maxFiles && visitedDirs < maxDirs) {
    const current = stack.pop() as string;
    visitedDirs += 1;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
        if (files.length >= maxFiles) break;
      }
    }
  }

  return files;
}

export async function readSmallTextFile(filePath: string, maxBytes = 5 * 1024 * 1024): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) return undefined;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function splitTextChunks(text: string, maxChunks = 200): string[] {
  const paragraphChunks = text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 12);
  const source = paragraphChunks.length > 1 ? paragraphChunks : text.split(/\r?\n/);
  const chunks: string[] = [];
  for (const raw of source) {
    const chunk = raw.replace(/\s+/g, ' ').trim();
    if (!chunk || chunk.length < 12) continue;
    chunks.push(chunk.slice(0, 2000));
    if (chunks.length >= maxChunks) break;
  }
  return chunks;
}

export function isTextMemoryFile(filePath: string): boolean {
  return /\.(md|mdx|txt|jsonl|json|ya?ml)$/i.test(filePath);
}

export function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'global';
}

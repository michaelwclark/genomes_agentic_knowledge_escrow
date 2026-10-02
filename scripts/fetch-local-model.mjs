#!/usr/bin/env node
// Downloads the pinned minishlab/potion-base-8M model2vec files used by the
// 'local' embedding provider (src/local-embedding.ts) into vendor/models/.
// The model is never committed to git (see .gitignore): this script is the
// one reproducible way to get it, verified against hardcoded sha256 hashes
// so a moved/edited upstream file is caught instead of silently trusted.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'minishlab/potion-base-8M';
// Pinned HF commit sha (resolved 2026-10-01 via
// https://huggingface.co/api/models/minishlab/potion-base-8M). Bump
// deliberately, re-verify hashes, and update both below when upgrading.
const REVISION = 'bf8b056651a2c21b8d2565580b8569da283cab23';

const FILES = [
  {
    name: 'model.safetensors',
    sha256: 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2'
  },
  {
    name: 'tokenizer.json',
    sha256: 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50'
  }
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.join(__dirname, '..', 'vendor', 'models', 'potion-base-8M');
// Optional: a local spike/cache dir to copy from instead of downloading.
// Still hash-verified below, so a stale or wrong copy is rejected, not trusted.
const sourceDir = process.env.KNOWLEDGE_ESCROW_LOCAL_MODEL_SOURCE_DIR;

async function main() {
  mkdirSync(targetDir, { recursive: true });
  for (const file of FILES) {
    const targetPath = path.join(targetDir, file.name);
    if (existsSync(targetPath) && sha256Of(readFileSync(targetPath)) === file.sha256) {
      console.log(`ok (already present, hash verified): ${file.name}`);
      continue;
    }
    const bytes = sourceDir ? await fromLocalCopy(sourceDir, file) : await fromDownload(file);
    const actual = sha256Of(bytes);
    if (actual !== file.sha256) {
      throw new Error(`sha256 mismatch for ${file.name}: expected ${file.sha256}, got ${actual}`);
    }
    writeFileSync(targetPath, bytes);
    console.log(`fetched + verified: ${file.name} (${bytes.length} bytes)`);
  }
}

async function fromLocalCopy(dir, file) {
  const sourcePath = path.join(dir, file.name);
  if (!existsSync(sourcePath)) {
    throw new Error(`KNOWLEDGE_ESCROW_LOCAL_MODEL_SOURCE_DIR set but ${sourcePath} does not exist`);
  }
  return readFileSync(sourcePath);
}

async function fromDownload(file) {
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.name}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed for ${file.name}: ${res.status} ${res.statusText} (${url})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

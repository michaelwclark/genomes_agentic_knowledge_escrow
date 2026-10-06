#!/usr/bin/env node
// Privacy/scrub gate for the public Knowledge Escrow repo. Scans every
// git-tracked (and locally untracked-but-present) file for a denylist of
// owner-specific hostnames, paths, project names, and emails that must
// never appear in public source, docs, tests, or fixtures. Optionally also
// scans a directory of built artifacts (including binaries, via a
// printable-ASCII-run extractor) so a leak baked into `dist/` or a bundled
// plugin is caught too.
//
// Usage:
//   node scripts/scrub-check.mjs                 # scan tracked source tree
//   node scripts/scrub-check.mjs --artifacts dist # also scan dist/ (text + binary)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// This script's own path is excluded from the scan further down, so the
// denylist can safely live here as plain strings.
const DENYLIST = [
  'genomesbox',
  'bigmac',
  '/Users/genome',
  '/home/genome',
  'losmon',
  'venturesgo',
  'thesummitgrp',
  'FLYWL',
  'Flywheel',
  'flywheel',
  'prayer',
  'mempalace',
  'cocoindex',
  'michaelwclark@',
  'mclark',
  'clarks_consulting'
];

// Strings that are allowed to appear even though they contain a denylisted
// substring (none currently do, but this is where an exception would go —
// e.g. the repo's own public URL, if it ever collided with an entry above).
const ALLOWLIST = ['github.com/michaelwclark/genomes_agentic_knowledge_escrow'];

// Exact third-party lines that legitimately contain a denylisted dictionary
// word. Each entry is pinned to a file suffix AND the full trimmed line, so a
// real leak elsewhere (or on any other line) in the same file still fails.
//  - the hash-pinned potion-base-8M tokenizer vocabulary (the English word)
//  - the stock Node.js binary's bundled ICU data (a collation test string)
const THIRD_PARTY_EXEMPTIONS = [
  { fileSuffix: 'models/potion-base-8M/tokenizer.json', line: '"prayer": 6089,' },
  { fileSuffix: 'models/potion-base-8M/tokenizer.json', line: '"prayers": 11589,' },
  { fileSuffix: 'bin/escrow-darwin-arm64', line: 'RADIOVIDEOCASSETTEFILM PROJECTORPORTABLE STEREOPRAYER BEADS' },
  { fileSuffix: 'bin/escrow-darwin-x86_64', line: 'RADIOVIDEOCASSETTEFILM PROJECTORPORTABLE STEREOPRAYER BEADS' }
];

function isExempt(file, line) {
  return THIRD_PARTY_EXEMPTIONS.some((entry) => file.endsWith(entry.fileSuffix) && line.trim() === entry.line);
}

const SELF_PATH = path.relative(process.cwd(), new URL(import.meta.url).pathname);

function stripAllowlisted(line) {
  let stripped = line;
  for (const allowed of ALLOWLIST) {
    stripped = stripped.split(allowed).join('');
  }
  return stripped;
}

function scanTextContent(label, content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const sanitized = stripAllowlisted(line);
    for (const term of DENYLIST) {
      if (sanitized.toLowerCase().includes(term.toLowerCase()) && !isExempt(label, line)) {
        hits.push({ file: label, lineNumber: i + 1, term, line: line.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

function listTrackedAndUntrackedFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8'
  });
  return output.split('\0').filter(Boolean);
}

// Extracts printable-ASCII runs of length >= 6 from a buffer, the same
// signal `strings` would give, without shelling out (keeps this portable to
// any machine with Node, including CI).
function extractPrintableStrings(buffer) {
  const runs = [];
  let current = '';
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 6) runs.push(current);
      current = '';
    }
  }
  if (current.length >= 6) runs.push(current);
  return runs.join('\n');
}

function listFilesRecursive(dir) {
  const results = [];
  const output = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' });
  for (const line of output.split('\n')) {
    if (line) results.push(line);
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const artifactsIdx = args.indexOf('--artifacts');
  const artifactsDir = artifactsIdx !== -1 ? args[artifactsIdx + 1] : undefined;

  const allHits = [];

  for (const file of listTrackedAndUntrackedFiles()) {
    if (path.resolve(file) === path.resolve(SELF_PATH)) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // deleted-but-staged, or a race with the working tree
    }
    if (!stat.isFile()) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable; source tree files are expected to be text
    }
    allHits.push(...scanTextContent(file, content));
  }

  if (artifactsDir) {
    for (const file of listFilesRecursive(artifactsDir)) {
      const buffer = readFileSync(file);
      // Try as UTF-8 text first (covers .js/.json/.md output); fall back to
      // the printable-ASCII-run extractor for anything binary (a bundled
      // SEA executable, a compiled model file, etc).
      const asText = buffer.toString('utf8');
      const looksBinary = asText.includes('\u0000');
      const content = looksBinary ? extractPrintableStrings(buffer) : asText;
      allHits.push(...scanTextContent(file, content));
    }
  }

  if (allHits.length === 0) {
    console.log(`scrub-check: 0 hits across ${artifactsDir ? 'source tree + ' + artifactsDir : 'source tree'}.`);
    return;
  }

  console.error(`scrub-check: ${allHits.length} hit(s) found:\n`);
  for (const hit of allHits) {
    console.error(`${hit.file}:${hit.lineNumber}: matched "${hit.term}"\n  ${hit.line}`);
  }
  process.exitCode = 1;
}

main();

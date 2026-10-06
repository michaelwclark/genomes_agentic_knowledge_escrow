import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { MEMORY_DISCIPLINE, runHook } from '../src/hooks.js';

interface HookResult {
  stdout: string;
  stderr: string;
}

async function invoke(args: string[], stdinText: string | undefined, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const stdin = new PassThrough();
  if (stdinText !== undefined) stdin.write(stdinText);
  stdin.end();
  let stdout = '';
  let stderr = '';
  await runHook(args, {
    env,
    stdin,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    }
  });
  return { stdout, stderr };
}

describe('escrow hook', () => {
  let root: string;
  let dataDir: string;
  let codexHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'escrow-hook-'));
    dataDir = path.join(root, 'data');
    codexHome = path.join(root, 'codex');
    env = { KNOWLEDGE_ESCROW_DATA_DIR: dataDir, CODEX_HOME: codexHome };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('emits SessionStart additional context for codex', async () => {
    const { stdout } = await invoke(['session-start', '--harness', 'codex'], '{}', env);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(MEMORY_DISCIPLINE);
  });

  it('emits the Claude SessionStart contract for claude', async () => {
    const { stdout } = await invoke(['session-start', '--harness', 'claude'], '{"session_id":"abc"}', env);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('memory_read');
  });

  it.each(['', 'not json', '[1,2]', 'null'])('tolerates bad stdin %j on session-start', async (input) => {
    const { stdout, stderr } = await invoke(['session-start'], input, env);
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(stderr).toBe('');
  });

  it('does not create the data dir on session-start', async () => {
    await invoke(['session-start', '--harness', 'codex'], '{}', env);
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('reports an unknown event on stderr only', async () => {
    const { stdout, stderr } = await invoke(['bogus'], '{}', env);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown event');
  });

  it('stop copies the transcript from transcript_path without modifying the source', async () => {
    const source = path.join(root, 'rollout-test.jsonl');
    await writeFile(source, '{"type":"message","content":"hello"}\n');
    const before = await stat(source);
    const { stdout } = await invoke(['stop', '--harness', 'claude'], JSON.stringify({ transcript_path: source }), env);
    expect(stdout).toBe('');
    expect(await readFile(path.join(dataDir, 'ingest', 'claude', 'rollout-test.jsonl'), 'utf8')).toContain('hello');
    expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);
  });

  it('stop copies from the env var path', async () => {
    const source = path.join(root, 'from-env.jsonl');
    await writeFile(source, 'line\n');
    await invoke(['stop', '--harness', 'codex'], '{}', { ...env, CODEX_SESSION_FILE: source });
    expect(await readdir(path.join(dataDir, 'ingest', 'codex'))).toEqual(['from-env.jsonl']);
  });

  it('stop finds the codex rollout by session id and prints {} for codex', async () => {
    const dayDir = path.join(codexHome, 'sessions', '2026', '10', '06');
    await mkdir(dayDir, { recursive: true });
    const rollout = path.join(dayDir, 'rollout-2026-10-06T10-00-00-0199aaaa-bbbb.jsonl');
    await writeFile(rollout, '{"type":"message","content":"found me"}\n');
    const { stdout } = await invoke(['stop', '--harness', 'codex'], '{"session_id":"0199aaaa-bbbb"}', env);
    expect(stdout.trim()).toBe('{}');
    expect(await readdir(path.join(dataDir, 'ingest', 'codex'))).toEqual([path.basename(rollout)]);
  });

  it('stop rejects a session id that tries to escape the sessions tree', async () => {
    const { stderr } = await invoke(['stop', '--harness', 'codex'], '{"session_id":"../../etc"}', env);
    expect(stderr).toBe('');
    await expect(readdir(path.join(dataDir, 'ingest', 'codex'))).rejects.toThrow();
  });

  it('stop never throws on a missing transcript', async () => {
    const { stdout, stderr } = await invoke(
      ['stop', '--harness', 'codex'],
      JSON.stringify({ transcript_path: path.join(root, 'nope.jsonl') }),
      env
    );
    expect(stdout.trim()).toBe('{}');
    expect(stderr).toBe('');
  });

  it('stop prunes ingest files older than the retention window', async () => {
    const ingest = path.join(dataDir, 'ingest', 'codex');
    await mkdir(ingest, { recursive: true });
    const old = path.join(ingest, 'old.jsonl');
    const fresh = path.join(ingest, 'fresh.jsonl');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await invoke(['stop', '--harness', 'codex'], '{}', env);
    expect((await readdir(ingest)).sort()).toEqual(['fresh.jsonl']);
  });

  it('honours KNOWLEDGE_ESCROW_INGEST_RETENTION_DAYS', async () => {
    const ingest = path.join(dataDir, 'ingest', 'codex');
    await mkdir(ingest, { recursive: true });
    const file = path.join(ingest, 'two-days.jsonl');
    await writeFile(file, 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(file, twoDaysAgo, twoDaysAgo);
    await invoke(['stop', '--harness', 'codex'], '{}', { ...env, KNOWLEDGE_ESCROW_INGEST_RETENTION_DAYS: '1' });
    expect(await readdir(ingest)).toEqual([]);
  });

  it('stop writes no durable memory: only the ingest dir appears', async () => {
    const source = path.join(root, 's.jsonl');
    await writeFile(source, '{"content":"decision made"}\n');
    await invoke(['stop', '--harness', 'claude'], JSON.stringify({ transcript_path: source }), env);
    expect(await readdir(dataDir)).toEqual(['ingest']);
  });

  it('copied transcripts surface through memory_read with sensitive values redacted', async () => {
    const source = path.join(root, 's.jsonl');
    await writeFile(source, `${JSON.stringify({ type: 'message', content: 'borrower ssn 123-45-6789 asked about refinance timing' })}\n`);
    await invoke(['stop', '--harness', 'claude'], JSON.stringify({ transcript_path: source }), env);
    const router = new MemoryRouter(
      loadConfig({ ...env, KNOWLEDGE_ESCROW_HOT_MEMORY_DIRS: path.join(dataDir, 'ingest', 'claude'), KNOWLEDGE_ESCROW_REDACTION: '1' })
    );
    try {
      const read = await router.read({ query: 'refinance timing', limit: 5 });
      const hot = read.hits.find((hit) => hit.substrate === 'hot_memory');
      expect(hot?.preview).toContain('[REDACTED:ssn]');
      expect(hot?.preview).not.toContain('123-45-6789');
    } finally {
      await router.close();
    }
  });
});

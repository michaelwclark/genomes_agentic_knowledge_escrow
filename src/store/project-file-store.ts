import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrainConfig, LayerHealth, MemoryHit, MemoryReadInput, MemoryRecord, MemorySubstrate } from '../types.js';
import { ensureMarkdownFile, pathExists, readSmallTextFile, slugPart, splitTextChunks, walkFiles } from './fs-utils.js';
import { scoreText } from './scoring.js';

type FileWrite = { substrate: MemorySubstrate; path: string };

export class ProjectFileStore {
  constructor(private readonly config: BrainConfig) {}

  async append(record: MemoryRecord): Promise<FileWrite[]> {
    if (!record.content || record.status !== 'committed') return [];
    const writes: FileWrite[] = [];
    if (record.substrates.includes('project_memory')) {
      const target = await this.findProjectMemoryTarget(record.scope.project, true);
      if (target) {
        await appendMarkdownMemory(target, record);
        writes.push({ substrate: 'project_memory', path: target });
      }
    }
    if (record.substrates.includes('user_memory')) {
      const target = await this.userMemoryTarget(record.scope.project);
      await appendMarkdownMemory(target, record);
      writes.push({ substrate: 'user_memory', path: target });
    }
    if (record.substrates.includes('feature_worklog')) {
      const target = await this.featureWorklogTarget(record);
      if (target) {
        await appendMarkdownMemory(target, record);
        writes.push({ substrate: 'feature_worklog', path: target });
      }
    }
    if (record.substrates.includes('agent_trace')) {
      const target = await this.agentTraceTarget(record);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, `${JSON.stringify(record)}\n`, 'utf8');
      writes.push({ substrate: 'agent_trace', path: target });
    }
    return writes;
  }

  async read(input: MemoryReadInput): Promise<MemoryHit[]> {
    const hits: MemoryHit[] = [];
    const markdownTargets = await this.readTargets(input);
    for (const target of markdownTargets) {
      const raw = await readSmallTextFile(target.path);
      if (!raw) continue;
      hits.push(...hitsFromText(target.substrate, target.path, raw, input, target.scope));
    }

    const traceFiles = await this.agentTraceFiles();
    for (const traceFile of traceFiles) {
      const raw = await readSmallTextFile(traceFile);
      if (!raw) continue;
      for (const line of raw.split(/\r?\n/).filter(Boolean).slice(-500)) {
        try {
          const record = JSON.parse(line) as MemoryRecord;
          if (input.project && record.scope.project !== input.project) continue;
          if (typeof input.feature === 'number' && record.scope.feature !== input.feature) continue;
          if (input.phase && record.scope.phase !== input.phase) continue;
          const content = record.content ?? JSON.stringify(record.provenance ?? {});
          const score = scoreText(input.query, `${record.title ?? ''} ${content}`);
          if (score <= 0 && input.query.trim()) continue;
          hits.push({
            substrate: 'agent_trace',
            id: record.id,
            path: traceFile,
            title: record.title ?? 'Agent trace',
            confidence: Math.max(0.01, Math.min(1, score)),
            scope: record.scope,
            content,
            kind: record.kind
          });
        } catch {
          continue;
        }
      }
    }

    return hits;
  }

  health(): LayerHealth[] {
    return [
      {
        id: 'project_memory',
        status: this.config.projectRoot || Object.keys(this.config.projectRoots).length > 0 ? 'ok' : 'disabled',
        detail:
          [
            this.config.projectRoot,
            Object.keys(this.config.projectRoots).length > 0
              ? `${Object.keys(this.config.projectRoots).length} registry root(s)`
              : undefined
          ]
            .filter(Boolean)
            .join(' + ') || 'KNOWLEDGE_ESCROW_PROJECT_ROOT(S) not set'
      },
      {
        id: 'user_memory',
        status: 'ok',
        detail: this.config.userMemoryRoot ?? path.join(this.config.dataDir, 'user-memory')
      },
      {
        id: 'feature_worklog',
        status: 'ok',
        detail: this.config.projectRoot
          ? 'project feature worklog discovery with data-dir fallback'
          : 'data-dir fallback only'
      },
      {
        id: 'agent_trace',
        status: 'ok',
        detail: path.join(this.config.dataDir, 'agent-traces')
      }
    ];
  }

  private async readTargets(input: MemoryReadInput): Promise<Array<{ substrate: MemorySubstrate; path: string; scope: Record<string, unknown> }>> {
    const targets: Array<{ substrate: MemorySubstrate; path: string; scope: Record<string, unknown> }> = [];
    const projectMemory = await this.findProjectMemoryTarget(input.project, false);
    if (projectMemory) targets.push({ substrate: 'project_memory', path: projectMemory, scope: { project: input.project } });
    const userMemory = await this.existingUserMemoryTarget(input.project);
    if (userMemory) targets.push({ substrate: 'user_memory', path: userMemory, scope: { project: input.project } });
    const featureWorklogs = await this.existingFeatureWorklogTargets(input);
    for (const featureWorklog of featureWorklogs) {
      targets.push({
        substrate: 'feature_worklog',
        path: featureWorklog,
        scope: { project: input.project, feature: input.feature }
      });
    }
    return targets;
  }

  private async findProjectMemoryTarget(project?: string, create: boolean = false): Promise<string | undefined> {
    const registryRoot = projectRootFromRegistry(this.config.projectRoots, project);
    if (registryRoot) {
      const target = path.join(registryRoot, 'MEMORY.md');
      if (create) await ensureMarkdownFile(target, `${project} Memory`);
      if (await pathExists(target)) return target;
    }
    const root = this.config.projectRoot;
    if (!root) return undefined;
    if (project) {
      const projectDir = await findProjectDir(root, project);
      if (projectDir) {
        const target = path.join(projectDir, 'MEMORY.md');
        if (create) await ensureMarkdownFile(target, `${project} Memory`);
        if (await pathExists(target)) return target;
      }
    }
    const rootMemory = path.join(root, 'MEMORY.md');
    if (create) await ensureMarkdownFile(rootMemory, 'Memory');
    return (await pathExists(rootMemory)) ? rootMemory : undefined;
  }

  private async userMemoryTarget(project?: string): Promise<string> {
    const root = this.config.userMemoryRoot ?? path.join(this.config.dataDir, 'user-memory');
    const target = path.join(root, slugPart(project ?? 'global'), 'MEMORY.md');
    await ensureMarkdownFile(target, `${project ?? 'Global'} User Memory`);
    return target;
  }

  private async existingUserMemoryTarget(project?: string): Promise<string | undefined> {
    const target = path.join(
      this.config.userMemoryRoot ?? path.join(this.config.dataDir, 'user-memory'),
      slugPart(project ?? 'global'),
      'MEMORY.md'
    );
    return (await pathExists(target)) ? target : undefined;
  }

  private async featureWorklogTarget(record: MemoryRecord): Promise<string | undefined> {
    const existing = await this.existingFeatureWorklogTarget({
      project: record.scope.project,
      feature: record.scope.feature,
      phase: record.scope.phase
    });
    if (existing) return existing;
    if (typeof record.scope.feature !== 'number') {
      const target = path.join(this.config.dataDir, 'features', 'unscoped', 'worklog.md');
      await ensureMarkdownFile(target, 'Unscoped Feature Worklog');
      return target;
    }
    const target = path.join(this.config.dataDir, 'features', String(record.scope.feature).padStart(3, '0'), 'worklog.md');
    await ensureMarkdownFile(target, `Feature ${record.scope.feature} Worklog`);
    return target;
  }

  private async existingFeatureWorklogTarget(input: Pick<MemoryReadInput, 'project' | 'feature' | 'phase'>): Promise<string | undefined> {
    return (await this.existingFeatureWorklogTargets(input))[0];
  }

  private async existingFeatureWorklogTargets(input: Pick<MemoryReadInput, 'project' | 'feature' | 'phase'>): Promise<string[]> {
    const targets: string[] = [];
    if (input.project && typeof input.feature === 'number') {
      const projectDirs: string[] = [];
      const registryRoot = projectRootFromRegistry(this.config.projectRoots, input.project);
      if (registryRoot) projectDirs.push(registryRoot);
      if (this.config.projectRoot) {
        const discovered = await findProjectDir(this.config.projectRoot, input.project);
        if (discovered) projectDirs.push(discovered);
      }
      for (const projectDir of projectDirs) {
        const featureDir = path.join(projectDir, 'features');
        const prefix = String(input.feature).padStart(3, '0');
        try {
          const entries = await fs.readdir(featureDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name === String(input.feature) || entry.name.startsWith(`${prefix}-`) || entry.name.startsWith(`${input.feature}-`)) {
              const target = path.join(featureDir, entry.name, 'worklog.md');
              if (await pathExists(target)) targets.push(target);
            }
          }
        } catch {
          // Fall through to data-dir fallback.
        }
      }
    }
    if (typeof input.feature === 'number') {
      const target = path.join(this.config.dataDir, 'features', String(input.feature).padStart(3, '0'), 'worklog.md');
      if (await pathExists(target)) targets.push(target);
      return [...new Set(targets)];
    }
    const fallbackTargets = await walkFiles([path.join(this.config.dataDir, 'features')], (file) => file.endsWith('worklog.md'), {
      maxFiles: 100,
      maxDirs: 500
    });
    return [...new Set([...targets, ...fallbackTargets])];
  }

  private async agentTraceTarget(record: MemoryRecord): Promise<string> {
    const day = record.createdAt.slice(0, 10);
    return path.join(this.config.dataDir, 'agent-traces', `${day}.jsonl`);
  }

  private async agentTraceFiles(): Promise<string[]> {
    return walkFiles([path.join(this.config.dataDir, 'agent-traces')], (file) => file.endsWith('.jsonl'), {
      maxFiles: 30,
      maxDirs: 100
    });
  }
}

async function appendMarkdownMemory(target: string, record: MemoryRecord): Promise<void> {
  await ensureMarkdownFile(target, path.basename(path.dirname(target)) === 'features' ? 'Feature Worklog' : 'Memory');
  const normalized = record.content?.replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  await fs.appendFile(target, `\n- ${record.createdAt} [${record.kind ?? 'Memory'}] ${normalized}\n`, 'utf8');
}

function hitsFromText(
  substrate: MemorySubstrate,
  filePath: string,
  text: string,
  input: MemoryReadInput,
  scope: Record<string, unknown>
): MemoryHit[] {
  return splitTextChunks(text)
    .map((chunk, index) => ({ chunk, index, score: scoreText(input.query, chunk) }))
    .filter(({ score }) => score > 0 || !input.query.trim())
    .map(({ chunk, index, score }) => ({
      substrate,
      id: stableId(`${filePath}:${index}:${chunk}`),
      path: filePath,
      title: `${path.basename(filePath)}:${index + 1}`,
      confidence: Math.max(0.01, Math.min(1, score)),
      scope: {
        project: typeof scope['project'] === 'string' ? scope['project'] : undefined,
        feature: typeof scope['feature'] === 'number' ? scope['feature'] : undefined
      },
      content: chunk
    }));
}

function normalizeProjectKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a project against the explicit name=path registry (dash/underscore tolerant). */
function projectRootFromRegistry(registry: Record<string, string>, project?: string): string | undefined {
  if (!project) return undefined;
  if (registry[project]) return registry[project];
  const wanted = normalizeProjectKey(project);
  for (const [key, value] of Object.entries(registry)) {
    if (normalizeProjectKey(key) === wanted) return value;
  }
  return undefined;
}

async function findProjectDir(root: string, project: string): Promise<string | undefined> {
  const suffix = path.join('02-projects', project);
  const matches = await walkFiles(
    [root],
    (file) => file.endsWith(path.join(suffix, 'project.yml')) || file.endsWith(path.join(suffix, 'status.md')),
    { maxFiles: 20, maxDirs: 5000 }
  );
  if (matches[0]) return path.dirname(matches[0]);
  const fallback = path.join(root, '02-projects', project);
  return (await pathExists(fallback)) ? fallback : undefined;
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

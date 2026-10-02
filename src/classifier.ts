import type { MemoryClassification, MemoryKind, MemoryScope, MemorySubstrate } from './types.js';

const KIND_SUBSTRATES: Record<MemoryKind, MemorySubstrate[]> = {
  PROJECT_RULE: ['jsonl', 'project_memory'],
  USER_PREF: ['jsonl', 'user_memory'],
  FEATURE_STATE: ['jsonl', 'feature_worklog'],
  AGENT_TRACE: ['jsonl', 'agent_trace'],
  FACT: ['jsonl', 'pgvector'],
  CROSS_FEATURE_LEARNING: ['jsonl', 'project_memory'],
  EPHEMERAL: ['jsonl']
};

export function classifyMemory(
  content: string,
  scope: MemoryScope = {},
  kindHint?: MemoryKind
): MemoryClassification {
  const kind = kindHint ?? inferKind(content);
  return {
    kind,
    title: inferTitle(content, kind),
    scope,
    substrates: KIND_SUBSTRATES[kind],
    confidence: kindHint ? 1 : 0.72
  };
}

function inferKind(content: string): MemoryKind {
  const text = content.toLowerCase();
  if (text.length < 12) return 'EPHEMERAL';
  if (/\b(always|never|prefer|prefers|preferred|preference|user wants|user likes|default to)\b/.test(text)) {
    return 'USER_PREF';
  }
  if (/\b(rule|policy|must|do not|project convention|standing instruction)\b/.test(text)) {
    return 'PROJECT_RULE';
  }
  if (/\b(feature|work item|state|status|blocked|ready|validated|acceptance criteria)\b/.test(text)) {
    return 'FEATURE_STATE';
  }
  if (/\b(trace|tool call|agent run|log|receipt|session|transcript)\b/.test(text)) {
    return 'AGENT_TRACE';
  }
  if (/\b(root cause|incident|lesson|learned|regression|surprise|non-obvious)\b/.test(text)) {
    return 'CROSS_FEATURE_LEARNING';
  }
  return 'FACT';
}

function inferTitle(content: string, kind: MemoryKind): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return kind;
  return firstLine.slice(0, 96);
}

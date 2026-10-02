import type { MemoryRouter } from '../router.js';
import { SERVICE_VERSION } from '../version.js';

interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const memoryTools: ToolDefinition[] = [
  {
    name: 'memory_read',
    description:
      'Search the unified memory plane across configured stores. Use for prior decisions, project rules, user preferences, feature state, and agent traces.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        feature: { type: 'number' },
        phase: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_write',
    description:
      'Write a memory. The router classifies the content, deduplicates it, and reports actual landing locations.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        project: { type: 'string' },
        feature: { type: 'number' },
        phase: { type: 'string' },
        persona: { type: 'string' },
        kindHint: {
          type: 'string',
          enum: [
            'PROJECT_RULE',
            'USER_PREF',
            'FEATURE_STATE',
            'AGENT_TRACE',
            'FACT',
            'CROSS_FEATURE_LEARNING',
            'EPHEMERAL'
          ]
        }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_forget',
    description: 'Soft-delete a memory by operation id or content hash.',
    inputSchema: {
      type: 'object',
      properties: {
        opId: { type: 'string' },
        contentHash: { type: 'string' }
      }
    }
  },
  {
    name: 'memory_link',
    description: 'Record a relation between two memory records.',
    inputSchema: {
      type: 'object',
      properties: {
        fromOpId: { type: 'string' },
        toOpId: { type: 'string' },
        relation: { type: 'string' }
      },
      required: ['fromOpId', 'toOpId', 'relation']
    }
  },
  {
    name: 'memory_analytics',
    description:
      'Return privacy-safe memory operation analytics: latency, errors, hit rate, dedupe rate, method rollups, and substrate usage.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Reporting window in hours. Defaults to 24.' }
      }
    }
  },
  {
    name: 'memory_health',
    description:
      'Return a structured Knowledge Escrow health report covering the ledger, observability store, retrieval layers, and optional databases.',
    inputSchema: {
      type: 'object',
      properties: {
        checkDatabases: { type: 'boolean', description: 'Ping the optional configured Postgres service.' }
      }
    }
  }
];

export async function handleJsonRpc(router: MemoryRouter, request: JsonRpcRequest) {
  try {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: router.getConfig().serverName ?? 'knowledge-escrow', version: SERVICE_VERSION }
        }
      };
    }

    if (request.method === 'notifications/initialized') return undefined;

    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id: request.id, result: { tools: memoryTools } };
    }

    if (request.method === 'tools/call') {
      const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const result = await callTool(router, params?.name ?? '', params?.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` }
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function callTool(router: MemoryRouter, name: string, args: Record<string, unknown>) {
  if (name === 'memory_read') {
    return router.read({
      query: stringArg(args, 'query'),
      project: optionalStringArg(args, 'project'),
      feature: optionalNumberArg(args, 'feature'),
      phase: optionalStringArg(args, 'phase'),
      limit: optionalNumberArg(args, 'limit')
    });
  }
  if (name === 'memory_write') {
    const content = stringArg(args, 'content');
    const kindHint = optionalKindArg(args, 'kindHint');
    const project = optionalStringArg(args, 'project');
    return router.write({
      content,
      kindHint,
      scope: {
        project,
        feature: optionalNumberArg(args, 'feature'),
        phase: optionalStringArg(args, 'phase'),
        persona: optionalStringArg(args, 'persona')
      }
    });
  }
  if (name === 'memory_forget') {
    return router.forget({
      opId: optionalStringArg(args, 'opId'),
      contentHash: optionalStringArg(args, 'contentHash')
    });
  }
  if (name === 'memory_link') {
    return router.link({
      fromOpId: stringArg(args, 'fromOpId'),
      toOpId: stringArg(args, 'toOpId'),
      relation: stringArg(args, 'relation')
    });
  }
  if (name === 'memory_analytics') {
    return router.analytics(optionalNumberArg(args, 'hours') ?? 24);
  }
  if (name === 'memory_health') {
    return router.healthReport(optionalBooleanArg(args, 'checkDatabases') ?? false);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing string argument: ${key}`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalKindArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  if (
    [
      'PROJECT_RULE',
      'USER_PREF',
      'FEATURE_STATE',
      'AGENT_TRACE',
      'FACT',
      'CROSS_FEATURE_LEARNING',
      'EPHEMERAL'
    ].includes(value)
  ) {
    return value as never;
  }
  throw new Error(`Invalid kindHint: ${value}`);
}

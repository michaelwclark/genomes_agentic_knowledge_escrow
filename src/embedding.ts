import { createHash } from 'node:crypto';
import { LocalStaticEmbeddingProvider } from './local-embedding.js';

const VECTOR_DIMS = 1536;
const OLLAMA_MAX_INPUT_CHARS = 2000;

export interface EmbeddingProvider {
  readonly id: 'none' | 'deterministic' | 'ollama' | 'local';
  readonly dimensions?: number;
  embed(text: string): Promise<number[] | null>;
}

export function createEmbeddingProvider(options: {
  provider: 'none' | 'deterministic' | 'ollama' | 'local';
  ollamaUrl: string;
  ollamaModel: string;
  localModelDir?: string;
}): EmbeddingProvider {
  if (options.provider === 'deterministic') {
    return {
      id: 'deterministic',
      dimensions: VECTOR_DIMS,
      embed: async (text) => deterministicEmbedding(text)
    };
  }
  if (options.provider === 'ollama') {
    return new OllamaEmbeddingProvider(options.ollamaUrl, options.ollamaModel);
  }
  if (options.provider === 'local') {
    if (!options.localModelDir) {
      throw new Error('KNOWLEDGE_ESCROW_EMBEDDING_PROVIDER=local requires KNOWLEDGE_ESCROW_LOCAL_MODEL_DIR to be set.');
    }
    return new LocalStaticEmbeddingProvider(options.localModelDir);
  }
  return {
    id: 'none',
    embed: async () => null
  };
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama' as const;
  private dimensionCache?: number;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  get dimensions(): number | undefined {
    return this.dimensionCache;
  }

  async embed(text: string): Promise<number[]> {
    const prompt = text.length > OLLAMA_MAX_INPUT_CHARS ? text.slice(0, OLLAMA_MAX_INPUT_CHARS) : text;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt })
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 240).replace(/\s+/g, ' ').trim();
      throw new Error(`ollama embeddings returned ${res.status} for model ${this.model}${detail ? `: ${detail}` : ''}`);
    }
    const body = await res.json() as { embedding?: unknown };
    if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
      throw new Error(`ollama returned no embedding for model ${this.model}`);
    }
    const embedding = body.embedding.map((value) => Number(value));
    if (embedding.some((value) => !Number.isFinite(value))) {
      throw new Error(`ollama returned a non-numeric embedding for model ${this.model}`);
    }
    this.dimensionCache = embedding.length;
    return embedding;
  }
}

export function deterministicEmbedding(text: string): number[] {
  const vector = Array.from({ length: VECTOR_DIMS }, () => 0);
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_'-]+/)
    .filter((term) => term.length > 1)
    .slice(0, 800);
  for (const term of terms) {
    const digest = createHash('sha256').update(term).digest();
    const index = digest.readUInt16BE(0) % VECTOR_DIMS;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export function toPgVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalStaticEmbeddingProvider, basicTokenize, wordpieceTokenize } from '../src/local-embedding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_MODEL_DIR = path.join(__dirname, '..', 'vendor', 'models', 'potion-base-8M');
const vendorModelPresent = existsSync(path.join(VENDOR_MODEL_DIR, 'model.safetensors')) &&
  existsSync(path.join(VENDOR_MODEL_DIR, 'tokenizer.json'));

describe('basicTokenize', () => {
  it('splits on whitespace', () => {
    expect(basicTokenize('hello world')).toEqual(['hello', 'world']);
  });

  it('splits punctuation into its own tokens', () => {
    expect(basicTokenize("Dana's deliverable, due Friday.")).toEqual([
      'dana',
      "'",
      's',
      'deliverable',
      ',',
      'due',
      'friday',
      '.'
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(basicTokenize('   ')).toEqual([]);
  });
});

describe('wordpieceTokenize', () => {
  const vocab = new Map([
    ['[UNK]', 0],
    ['hello', 1],
    ['world', 2],
    ['foo', 3],
    ['##bar', 4],
    ['baz', 5]
  ]);

  it('matches a whole-word vocab entry directly', () => {
    expect(wordpieceTokenize('hello', vocab)).toEqual(['hello']);
  });

  it('greedily splits an unseen word into known prefix + continuation pieces', () => {
    expect(wordpieceTokenize('foobar', vocab)).toEqual(['foo', '##bar']);
  });

  it('returns [UNK] when no split of the word is in vocab', () => {
    expect(wordpieceTokenize('zzz', vocab)).toEqual(['[UNK]']);
  });

  it('returns [UNK] for a word longer than maxInputCharsPerWord', () => {
    expect(wordpieceTokenize('hello', vocab, 3)).toEqual(['[UNK]']);
  });
});

/** Builds a minimal valid safetensors file containing one F32 "embeddings" tensor. */
function writeSyntheticSafetensors(filePath: string, vocabSize: number, dim: number, values: number[]): void {
  const header = JSON.stringify({
    embeddings: { dtype: 'F32', shape: [vocabSize, dim], data_offsets: [0, vocabSize * dim * 4] }
  });
  const headerBuf = Buffer.from(header, 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
  const dataBuf = Buffer.alloc(vocabSize * dim * 4);
  for (let i = 0; i < values.length; i += 1) dataBuf.writeFloatLE(values[i] ?? 0, i * 4);
  writeFileSync(filePath, Buffer.concat([lenBuf, headerBuf, dataBuf]));
}

function writeSyntheticTokenizer(filePath: string, vocab: Record<string, number>): void {
  writeFileSync(filePath, JSON.stringify({ model: { vocab } }));
}

describe('LocalStaticEmbeddingProvider with a synthetic tiny model', () => {
  // vocab 6 x dim 4: id -> row
  // 0 [UNK] [0,0,0,0]   1 hello [1,0,0,0]   2 world [0,1,0,0]
  // 3 foo   [0,0,1,0]   4 ##bar [0,0,0,1]   5 baz   [1,1,1,1]
  function buildModelDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'local-embedding-test-'));
    writeSyntheticSafetensors(
      path.join(dir, 'model.safetensors'),
      6,
      4,
      [
        0, 0, 0, 0,
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
        1, 1, 1, 1
      ]
    );
    writeSyntheticTokenizer(path.join(dir, 'tokenizer.json'), {
      '[UNK]': 0,
      hello: 1,
      world: 2,
      foo: 3,
      '##bar': 4,
      baz: 5
    });
    return dir;
  }

  it('reports its id and dimensions after the first embed', async () => {
    const provider = new LocalStaticEmbeddingProvider(buildModelDir());
    expect(provider.id).toBe('local');
    expect(provider.dimensions).toBeUndefined();
    await provider.embed('hello');
    expect(provider.dimensions).toBe(4);
  });

  it('mean-pools known whole-word tokens and L2-normalizes deterministically', async () => {
    const provider = new LocalStaticEmbeddingProvider(buildModelDir());
    const vector = await provider.embed('hello world');
    const expectedComponent = 1 / Math.sqrt(2);
    expect(vector).not.toBeNull();
    expect(vector?.[0]).toBeCloseTo(expectedComponent, 6);
    expect(vector?.[1]).toBeCloseTo(expectedComponent, 6);
    expect(vector?.[2]).toBeCloseTo(0, 6);
    expect(vector?.[3]).toBeCloseTo(0, 6);
  });

  it('mean-pools a greedily-split WordPiece word (foo + ##bar)', async () => {
    const provider = new LocalStaticEmbeddingProvider(buildModelDir());
    const vector = await provider.embed('foobar');
    const expectedComponent = 1 / Math.sqrt(2);
    expect(vector?.[0]).toBeCloseTo(0, 6);
    expect(vector?.[1]).toBeCloseTo(0, 6);
    expect(vector?.[2]).toBeCloseTo(expectedComponent, 6);
    expect(vector?.[3]).toBeCloseTo(expectedComponent, 6);
  });

  it('falls back to the [UNK] vector when nothing matches', async () => {
    const provider = new LocalStaticEmbeddingProvider(buildModelDir());
    const vector = await provider.embed('@@@');
    expect(vector).toEqual([0, 0, 0, 0]);
  });

  it('is deterministic: repeated embeds of the same text produce the same vector', async () => {
    const provider = new LocalStaticEmbeddingProvider(buildModelDir());
    const first = await provider.embed('hello world');
    const second = await provider.embed('hello world');
    expect(second).toEqual(first);
  });

  it('throws a clear error naming the missing path when model files are absent', async () => {
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'local-embedding-missing-'));
    const provider = new LocalStaticEmbeddingProvider(emptyDir);
    await expect(provider.embed('hello')).rejects.toThrow(emptyDir);
  });
});

describe.skipIf(!vendorModelPresent)('LocalStaticEmbeddingProvider semantic probe (vendor model)', () => {
  const memories = [
    "Decision: we chose Acme as the SSO vendor after Tuesday's meeting",
    'Dana prefers async updates in Slack over meetings',
    'I owe Priya the Q4 roadmap draft by Friday',
    'Always CC legal on vendor contract emails',
    'Launch reviews go better with a pre-read sent 48h ahead',
    'Initiative Atlas is blocked on data warehouse access'
  ];

  function cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return dot; // both are already L2-normalized
  }

  it('ranks the correct memory top-1 for each probe query', async () => {
    const provider = new LocalStaticEmbeddingProvider(VENDOR_MODEL_DIR);
    const memoryVectors = await Promise.all(memories.map((text) => provider.embed(text)));

    const cases: Array<{ query: string; expectedIndex: number }> = [
      { query: 'which identity provider did we pick', expectedIndex: 0 },
      { query: 'what deliverable is due to Priya', expectedIndex: 2 },
      { query: 'how does Dana like to communicate', expectedIndex: 1 }
    ];

    for (const { query, expectedIndex } of cases) {
      const queryVector = await provider.embed(query);
      const scored = memoryVectors
        .map((vector, index) => ({ index, score: cosine(queryVector as number[], vector as number[]) }))
        .sort((a, b) => b.score - a.score);
      expect(scored[0]?.index).toBe(expectedIndex);
    }
  });
});

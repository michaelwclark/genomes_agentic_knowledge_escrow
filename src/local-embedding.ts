import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import type { EmbeddingProvider } from './embedding.js';

/**
 * Offline model2vec (potion-base-8M) static-embedding provider, ported from
 * the proven spike at <scratch>/embed-spike/potion.mjs. No ONNX runtime, no
 * native addon, no network at inference time: a safetensors-backed per-token
 * embedding table, mean-pooled over WordPiece tokens, then L2-normalized.
 * This is what lets Knowledge Escrow ship as a Codex plugin with zero
 * runtime dependencies on the teammate's machine.
 */

interface SafetensorsEmbeddingTensor {
  dtype?: string;
  shape?: number[];
  data_offsets?: number[];
}

interface LoadedSafetensorsEmbeddings {
  floats: Float32Array;
  vocabSize: number;
  dim: number;
}

/**
 * Reads the single `embeddings` tensor out of a safetensors file without
 * pulling in a safetensors library. The format is: an 8-byte little-endian
 * header length, a JSON header describing each tensor's dtype/shape/byte
 * range, then the raw tensor bytes.
 *
 * Data is copied into a freshly, non-pool-allocated buffer (`allocUnsafeSlow`)
 * before constructing the `Float32Array` view. `Buffer.alloc`/`allocUnsafe`
 * for small sizes can be served from Node's internal buffer pool at a
 * non-4-byte-aligned offset into a shared ArrayBuffer, which makes
 * `new Float32Array(buf.buffer, buf.byteOffset, ...)` throw a RangeError.
 * `allocUnsafeSlow` always backs the buffer with its own ArrayBuffer at
 * offset 0, so the view is safe regardless of tensor size — this matters
 * most for small synthetic tensors in tests, not just the 30MB model file.
 */
function loadSafetensorsEmbeddings(filePath: string, tensorName = 'embeddings'): LoadedSafetensorsEmbeddings {
  const fd = openSync(filePath, 'r');
  try {
    const lenBuf = Buffer.allocUnsafeSlow(8);
    readSync(fd, lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    const headerBuf = Buffer.allocUnsafeSlow(headerLen);
    readSync(fd, headerBuf, 0, headerLen, 8);
    const header = JSON.parse(headerBuf.toString('utf8')) as Record<string, SafetensorsEmbeddingTensor | string>;
    const entry = header[tensorName];
    if (!entry || typeof entry === 'string') {
      throw new Error(`safetensors file ${filePath} has no "${tensorName}" tensor`);
    }
    const { dtype, shape, data_offsets: dataOffsets } = entry;
    if (dtype !== 'F32') {
      throw new Error(`safetensors "${tensorName}" tensor in ${filePath} has unsupported dtype ${String(dtype)}; expected F32`);
    }
    if (!shape || shape.length !== 2 || !dataOffsets || dataOffsets.length !== 2) {
      throw new Error(`safetensors "${tensorName}" tensor in ${filePath} has an unexpected shape or data_offsets`);
    }
    const [vocabSize, dim] = shape as [number, number];
    const [start, end] = dataOffsets as [number, number];
    const dataBuf = Buffer.allocUnsafeSlow(end - start);
    readSync(fd, dataBuf, 0, end - start, 8 + headerLen + start);
    const floats = new Float32Array(dataBuf.buffer, dataBuf.byteOffset, (end - start) / 4);
    return { floats, vocabSize, dim };
  } finally {
    closeSync(fd);
  }
}

/** BERT basic tokenizer: lowercase, split punctuation/symbols into their own tokens. */
export function basicTokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let current = '';
  for (const ch of lower) {
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else if (/[\p{P}\p{S}]/u.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      tokens.push(ch);
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Greedy longest-match-first WordPiece tokenizer. Returns `['[UNK]']` for a word with no valid split. */
export function wordpieceTokenize(word: string, vocab: Map<string, number>, maxInputCharsPerWord = 100): string[] {
  if (word.length > maxInputCharsPerWord) return ['[UNK]'];
  const out: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let currentSub: string | null = null;
    while (start < end) {
      let sub = word.slice(start, end);
      if (start > 0) sub = `##${sub}`;
      if (vocab.has(sub)) {
        currentSub = sub;
        break;
      }
      end -= 1;
    }
    if (currentSub === null) return ['[UNK]'];
    out.push(currentSub);
    start = end;
  }
  return out;
}

interface LoadedModel {
  floats: Float32Array;
  dim: number;
  vocab: Map<string, number>;
  unkId: number | undefined;
}

export class LocalStaticEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local' as const;
  private dimsCache?: number;
  private loaded?: LoadedModel;
  private loadPromise?: Promise<void>;

  constructor(private readonly modelDir: string) {}

  get dimensions(): number | undefined {
    return this.dimsCache;
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded();
    const { floats, dim, vocab, unkId } = this.loaded as LoadedModel;

    const addTokenVector = (id: number, out: Float32Array): void => {
      const offset = id * dim;
      for (let i = 0; i < dim; i += 1) out[i] += floats[offset + i];
    };

    const ids: number[] = [];
    for (const word of basicTokenize(text)) {
      for (const piece of wordpieceTokenize(word, vocab)) {
        if (piece === '[UNK]') continue; // model2vec drops UNK at inference
        const id = vocab.get(piece);
        if (id !== undefined) ids.push(id);
      }
    }

    const out = new Float32Array(dim);
    if (ids.length === 0) {
      if (unkId === undefined) {
        throw new Error(`local embedding model in ${this.modelDir} has no [UNK] token and no tokens matched "${text.slice(0, 80)}"`);
      }
      addTokenVector(unkId, out);
      ids.push(unkId);
    } else {
      for (const id of ids) addTokenVector(id, out);
    }
    for (let i = 0; i < dim; i += 1) out[i] /= ids.length;

    let norm = 0;
    for (let i = 0; i < dim; i += 1) norm += out[i] * out[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i += 1) out[i] /= norm;

    return Array.from(out);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    const safetensorsPath = path.join(this.modelDir, 'model.safetensors');
    const tokenizerPath = path.join(this.modelDir, 'tokenizer.json');
    if (!existsSync(safetensorsPath) || !existsSync(tokenizerPath)) {
      throw new Error(
        `local embedding model files not found in ${this.modelDir} (expected model.safetensors and tokenizer.json). ` +
          'Run "npm run fetch-local-model" or set KNOWLEDGE_ESCROW_LOCAL_MODEL_DIR to a directory containing them.'
      );
    }
    const { floats, dim } = loadSafetensorsEmbeddings(safetensorsPath);
    const tokenizerJson = JSON.parse(readFileSync(tokenizerPath, 'utf8')) as {
      model?: { vocab?: Record<string, number> };
    };
    const vocabEntries = tokenizerJson.model?.vocab;
    if (!vocabEntries) {
      throw new Error(`tokenizer.json in ${this.modelDir} has no model.vocab`);
    }
    const vocab = new Map(Object.entries(vocabEntries));
    this.dimsCache = dim;
    this.loaded = { floats, dim, vocab, unkId: vocab.get('[UNK]') };
  }
}

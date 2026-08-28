/**
 * Embedding generation.
 *
 * The primary path asks the configured backend for real embeddings (Ollama with
 * `nomic-embed-text` by default). If no embedding model is installed we fall
 * back to a local hashed bag-of-features vector so memory retrieval degrades
 * rather than breaking — which matters, because "works offline with zero setup"
 * is a core promise of this app.
 *
 * The fallback is honestly worse: it captures lexical overlap, not meaning. The
 * UI says so, and `isSemantic` lets callers tell the two apart.
 */
import 'server-only';

import { getProvider } from '@/lib/llm';
import { getSettings } from '@/lib/settings';

/** Dimensionality of the local fallback embedder. */
export const FALLBACK_DIM = 384;
export const FALLBACK_MODEL = 'forge-lexical-v1';

export interface EmbeddingResult {
  vectors: Float32Array[];
  model: string;
  dim: number;
  /** False when the lexical fallback produced these vectors. */
  isSemantic: boolean;
}

/**
 * Remembers a failed embedding backend for a short while.
 *
 * Without this, every memory write during an outage pays a full network timeout
 * before falling back — turning a fast local operation into a multi-second one.
 */
const backendState = { failedUntil: 0 };
const FAILURE_COOLDOWN_MS = 60_000;

export async function embed(texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return { vectors: [], model: FALLBACK_MODEL, dim: FALLBACK_DIM, isSemantic: false };
  }

  const settings = getSettings();
  const model = settings.embeddingModel.trim();

  if (model && Date.now() >= backendState.failedUntil) {
    try {
      const provider = getProvider(settings.defaultProvider);
      if (provider.embed) {
        const raw = await provider.embed(texts, model);

        // A backend can return an empty array for an unknown model without
        // erroring; treat that as failure rather than storing zero vectors.
        if (raw.length === texts.length && raw.every((v) => v.length > 0)) {
          const dim = raw[0].length;
          return {
            vectors: raw.map((v) => normalize(Float32Array.from(v))),
            model,
            dim,
            isSemantic: true,
          };
        }
      }
    } catch {
      backendState.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
    }
  }

  return {
    vectors: texts.map(lexicalEmbed),
    model: FALLBACK_MODEL,
    dim: FALLBACK_DIM,
    isSemantic: false,
  };
}

export async function embedOne(text: string): Promise<EmbeddingResult> {
  return embed([text]);
}

/**
 * Local fallback embedder: hashed word unigrams, bigrams and character
 * trigrams, with sub-linear term frequency and L2 normalisation.
 *
 * Character trigrams are what make it tolerate typos and morphology ("running"
 * still overlaps "run"), which a pure word-hash model would miss entirely.
 */
export function lexicalEmbed(text: string): Float32Array {
  const vector = new Float32Array(FALLBACK_DIM);
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = normalized.split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const add = (token: string, weight: number) => {
    const index = hash(token) % FALLBACK_DIM;
    vector[index] += weight;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    add(word, 1);
    // Bigrams capture a little word order, which unigrams throw away.
    if (i + 1 < words.length) add(`${word}_${words[i + 1]}`, 0.6);

    const padded = `#${word}#`;
    for (let j = 0; j + 3 <= padded.length; j++) add(padded.slice(j, j + 3), 0.28);
  }

  // Sub-linear scaling stops a word repeated ten times from dominating the
  // vector — the same reason TF-IDF uses log term frequency.
  for (let i = 0; i < vector.length; i++) {
    if (vector[i] > 0) vector[i] = 1 + Math.log(vector[i]);
  }

  return normalize(vector);
}

/** FNV-1a over UTF-16 code units. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Scales a vector to unit length, so cosine similarity reduces to a dot product
 * — the single biggest win available for brute-force search at this scale.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  return vector;
}

/** Dot product. Equals cosine similarity for the normalised vectors we store. */
export function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

/** Float32Array ⇄ SQLite BLOB. Stored little-endian, as the platform writes it. */
export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // A Float32Array view needs 4-byte alignment; SQLite gives no such guarantee,
  // so copy when the offset is misaligned rather than throwing.
  if (buffer.byteOffset % 4 !== 0) {
    const copy = Buffer.from(buffer);
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  }
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'as', 'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'it', 'its', 'they',
  'them', 'their', 'he', 'she', 'his', 'her', 'you', 'your', 'we', 'our', 'us', 'me', 'my',
  'i', 'so', 'too', 'very', 'just', 'not', 'no', 'nor', 'can', 'will', 'would', 'should',
  'could', 'may', 'might', 'must', 'there', 'here', 'when', 'where', 'why', 'how', 'what',
  'which', 'who', 'whom', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
]);

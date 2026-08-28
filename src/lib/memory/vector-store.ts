/**
 * Memory retrieval: hybrid vector + keyword search over the memories table.
 *
 * Why no ChromaDB / LanceDB
 * -------------------------
 * A personal knowledge base is thousands of memories, not millions. A brute
 * force scan of 10k × 384-dim normalised vectors is a few million multiply-adds
 * — under 5ms in plain JS, and it stays exact where an ANN index only
 * approximates. Adding a second datastore would mean a second process to run, a
 * second thing to back up, and a consistency problem between the two. Storing
 * vectors as BLOBs next to their text keeps the entire app one SQLite file.
 *
 * If this ever needs to scale past ~100k memories, the swap-in point is
 * `scoreAll()` alone.
 */
import 'server-only';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { getDb, getSqlite } from '@/db';
import { memories, type Memory, type MemoryKind } from '@/db/schema';
import { getSettings } from '@/lib/settings';
import { dot, embedOne, fromBlob } from './embeddings';

export interface RetrievalOptions {
  /** Restricts to global memories plus this project's. Omit for global only. */
  projectId?: string | null;
  profileId?: string | null;
  topK?: number;
  minScore?: number;
  kinds?: MemoryKind[];
  /** Pinned memories bypass scoring entirely and are always returned. */
  includePinned?: boolean;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  vectorScore: number;
  keywordScore: number;
  /** Why this memory surfaced — shown in the citation popover. */
  reason: 'pinned' | 'semantic' | 'keyword' | 'hybrid';
}

/**
 * Cached vectors, keyed by memory id.
 *
 * Deserialising every BLOB on every turn is the actual cost here, not the dot
 * products. The cache is invalidated wholesale on any memory write — memories
 * are written far less often than they are read.
 */
interface VectorCache {
  vectors: Map<string, Float32Array>;
  generation: number;
}

const globalForCache = globalThis as unknown as {
  __forgeVectors?: VectorCache;
  __forgeMemGeneration?: number;
};

function generation(): number {
  return (globalForCache.__forgeMemGeneration ??= 1);
}

/** Call after any write that changes memory text or embeddings. */
export function invalidateVectorCache(): void {
  globalForCache.__forgeMemGeneration = generation() + 1;
  globalForCache.__forgeVectors = undefined;
}

function vectorCache(rows: Memory[]): Map<string, Float32Array> {
  const current = globalForCache.__forgeVectors;
  if (current && current.generation === generation()) return current.vectors;

  const vectors = new Map<string, Float32Array>();
  for (const row of rows) {
    const vector = fromBlob(row.embedding as Buffer | null);
    if (vector) vectors.set(row.id, vector);
  }

  globalForCache.__forgeVectors = { vectors, generation: generation() };
  return vectors;
}

/**
 * Finds the memories most relevant to `query`.
 *
 * Scores blend three signals:
 *  - cosine similarity against the query embedding (semantic match),
 *  - BM25 rank from SQLite FTS5 (exact terms, names, numbers — where embeddings
 *    are famously weak),
 *  - a small prior from importance, recency and past usefulness.
 */
export async function retrieveMemories(
  query: string,
  options: RetrievalOptions = {},
): Promise<ScoredMemory[]> {
  const settings = getSettings();
  const db = getDb();

  const topK = options.topK ?? settings.memoryTopK;
  const minScore = options.minScore ?? settings.memoryMinScore;
  const vectorWeight = settings.memoryVectorWeight;

  const scopeFilter = options.projectId
    ? or(isNull(memories.projectId), eq(memories.projectId, options.projectId))
    : isNull(memories.projectId);

  const rows = db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.archived, false),
        scopeFilter,
        options.kinds?.length ? inArray(memories.kind, options.kinds) : undefined,
      ),
    )
    .all();

  if (rows.length === 0) return [];

  const pinned = options.includePinned === false ? [] : rows.filter((r) => r.pinned);
  const candidates = rows.filter((r) => !r.pinned);

  if (!query.trim() || candidates.length === 0) {
    return pinned.map((memory) => ({
      memory,
      score: 1,
      vectorScore: 0,
      keywordScore: 0,
      reason: 'pinned' as const,
    }));
  }

  const { vectors: [queryVector] } = await embedOne(query);
  const cache = vectorCache(rows);
  const keyword = keywordScores(query, candidates.length);

  const scored: ScoredMemory[] = [];

  for (const memory of candidates) {
    const stored = cache.get(memory.id);
    // Only compare vectors of the same dimensionality: a memory embedded with
    // the fallback embedder cannot be compared to one from a real model.
    const vectorScore =
      stored && queryVector && stored.length === queryVector.length
        ? Math.max(0, dot(stored, queryVector))
        : 0;

    const keywordScore = keyword.get(memory.id) ?? 0;
    const relevance = vectorWeight * vectorScore + (1 - vectorWeight) * keywordScore;

    // The prior is deliberately gentle (±~15%): it should break ties between
    // similarly relevant memories, never surface an irrelevant one.
    const score = relevance * (1 + 0.15 * prior(memory));

    if (score >= minScore) {
      scored.push({
        memory,
        score,
        vectorScore,
        keywordScore,
        reason:
          vectorScore > 0 && keywordScore > 0
            ? 'hybrid'
            : keywordScore > 0
              ? 'keyword'
              : 'semantic',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return [
    ...pinned.map((memory) => ({
      memory,
      score: 1,
      vectorScore: 0,
      keywordScore: 0,
      reason: 'pinned' as const,
    })),
    ...scored.slice(0, topK),
  ];
}

/**
 * BM25 scores from FTS5, normalised to 0..1 by rank.
 *
 * Raw BM25 is unbounded and corpus-dependent, so it cannot be blended with a
 * cosine score directly. Rank-based normalisation is scale-free and is what
 * makes the two signals commensurable.
 */
function keywordScores(query: string, candidateCount: number): Map<string, number> {
  const scores = new Map<string, number>();
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) return scores;

  // Quote each term so FTS5 never interprets user text as query syntax, and OR
  // them so partial matches still rank.
  const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const limit = Math.max(candidateCount, 50);

  try {
    const rows = getSqlite()
      .prepare(
        `SELECT id, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{ id: string; rank: number }>;

    rows.forEach((row, index) => {
      scores.set(row.id, 1 - index / rows.length);
    });
  } catch {
    // A malformed FTS query should degrade to pure vector search, not 500.
  }

  return scores;
}

/**
 * Non-relevance signal in 0..1: how much this memory has earned its place.
 * Importance dominates; recency and proven usefulness nudge.
 */
function prior(memory: Memory): number {
  const ageDays = (Date.now() - memory.createdAt) / 86_400_000;
  // 90-day half-life: a memory from last week outranks one from last year, but
  // an old memory never decays to irrelevance.
  const recency = Math.exp(-ageDays / 90);
  const usage = Math.min(memory.accessCount / 10, 1);

  return 0.6 * memory.importance + 0.25 * recency + 0.15 * usage;
}

/** Records that these memories were used, feeding the usage prior. */
export function markAccessed(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  db.update(memories)
    .set({
      accessCount: sql`${memories.accessCount} + 1`,
      lastAccessedAt: Date.now(),
    })
    .where(inArray(memories.id, ids))
    .run();
}

/** Free-text search for the memory browser UI. */
export async function searchMemories(
  query: string,
  options: { limit?: number; projectId?: string | null; includeArchived?: boolean } = {},
): Promise<ScoredMemory[]> {
  const limit = options.limit ?? 50;

  if (!query.trim()) {
    const db = getDb();
    const rows = db
      .select()
      .from(memories)
      .where(options.includeArchived ? undefined : eq(memories.archived, false))
      .orderBy(desc(memories.pinned), desc(memories.createdAt))
      .limit(limit)
      .all();

    return rows.map((memory) => ({
      memory,
      score: 0,
      vectorScore: 0,
      keywordScore: 0,
      reason: 'semantic' as const,
    }));
  }

  return retrieveMemories(query, {
    projectId: options.projectId,
    topK: limit,
    // The browser should show weak matches too — the user is exploring, not
    // building a prompt, so a low floor is the right default here.
    minScore: 0.05,
  });
}

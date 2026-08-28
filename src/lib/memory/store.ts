/**
 * Memory CRUD.
 *
 * Every write goes through here so that embedding generation, de-duplication
 * and cache invalidation can never be forgotten at a call site.
 */
import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { activity, memories, memoryLinks, type Memory, type MemoryKind, type MemorySource } from '@/db/schema';
import { createId } from '@/lib/ids';
import { dot, embed, fromBlob, toBlob } from './embeddings';
import { invalidateVectorCache } from './vector-store';

/** Above this cosine similarity two memories say the same thing. */
const DUPLICATE_THRESHOLD = 0.92;

export interface CreateMemoryInput {
  content: string;
  title?: string;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  source?: MemorySource;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  projectId?: string | null;
  profileId?: string | null;
  tags?: string[];
  pinned?: boolean;
}

export interface CreateMemoryResult {
  memory: Memory;
  /** True when an existing near-identical memory was strengthened instead. */
  deduplicated: boolean;
}

/**
 * Creates a memory, or reinforces an existing one that already says the same
 * thing.
 *
 * De-duplication is what keeps an automatic extractor from filling the store
 * with fifty variations of "the user lives in Berlin". When a duplicate is
 * found we raise its importance and confidence rather than adding a row —
 * repetition across conversations is evidence, so the memory gets *stronger*.
 */
export async function createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult> {
  const db = getDb();
  const content = input.content.trim();
  if (!content) throw new Error('Memory content cannot be empty.');

  const { vectors, model, dim, isSemantic } = await embed([content]);
  const vector = vectors[0];

  const existing = findDuplicate(vector, input.projectId ?? null);
  if (existing) {
    const updated = db
      .update(memories)
      .set({
        importance: Math.min(1, existing.importance + 0.1),
        confidence: Math.min(1, existing.confidence + 0.05),
        accessCount: sql`${memories.accessCount} + 1`,
        updatedAt: Date.now(),
      })
      .where(eq(memories.id, existing.id))
      .returning()
      .get();

    invalidateVectorCache();
    return { memory: updated, deduplicated: true };
  }

  const now = Date.now();
  const memory = db
    .insert(memories)
    .values({
      id: createId('mem'),
      content,
      title: input.title ?? deriveTitle(content),
      kind: input.kind ?? 'fact',
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? (input.source === 'manual' ? 1 : 0.8)),
      source: input.source ?? 'auto',
      sourceConversationId: input.sourceConversationId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      projectId: input.projectId ?? null,
      profileId: input.profileId ?? null,
      tags: input.tags ?? [],
      pinned: input.pinned ?? false,
      embedding: toBlob(vector),
      // Recording *which* embedder produced this lets retrieval avoid comparing
      // semantic vectors against lexical ones, and lets a re-index find the
      // rows that need upgrading once a real model is installed.
      embeddingModel: isSemantic ? model : `${model}:lexical`,
      embeddingDim: dim,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  db.insert(activity)
    .values({
      id: createId('act'),
      type: 'memory.created',
      title: memory.title ?? 'New memory',
      detail: memory.kind,
      entityId: memory.id,
      createdAt: now,
    })
    .run();

  invalidateVectorCache();
  return { memory, deduplicated: false };
}

/** Scans same-scope memories for one that already says this. */
function findDuplicate(vector: Float32Array, projectId: string | null): Memory | null {
  const db = getDb();
  const rows = db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.archived, false),
        projectId ? eq(memories.projectId, projectId) : sql`${memories.projectId} IS NULL`,
      ),
    )
    .all();

  for (const row of rows) {
    const stored = fromBlob(row.embedding as Buffer | null);
    if (!stored || stored.length !== vector.length) continue;
    if (dot(stored, vector) >= DUPLICATE_THRESHOLD) return row;
  }
  return null;
}

export async function updateMemory(
  id: string,
  patch: Partial<CreateMemoryInput> & { archived?: boolean },
): Promise<Memory | null> {
  const db = getDb();
  const current = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!current) return null;

  const contentChanged = patch.content !== undefined && patch.content.trim() !== current.content;

  const embedding = contentChanged
    ? await embed([patch.content!.trim()])
    : null;

  const updated = db
    .update(memories)
    .set({
      ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.importance !== undefined ? { importance: clamp01(patch.importance) } : {}),
      ...(patch.confidence !== undefined ? { confidence: clamp01(patch.confidence) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(embedding
        ? {
            embedding: toBlob(embedding.vectors[0]),
            embeddingModel: embedding.isSemantic
              ? embedding.model
              : `${embedding.model}:lexical`,
            embeddingDim: embedding.dim,
          }
        : {}),
      updatedAt: Date.now(),
    })
    .where(eq(memories.id, id))
    .returning()
    .get();

  invalidateVectorCache();
  return updated;
}

export function deleteMemory(id: string): void {
  const db = getDb();
  db.delete(memories).where(eq(memories.id, id)).run();
  invalidateVectorCache();
}

export function deleteMemories(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  db.delete(memories).where(inArray(memories.id, ids)).run();
  invalidateVectorCache();
}

export function getMemory(id: string): Memory | null {
  return getDb().select().from(memories).where(eq(memories.id, id)).get() ?? null;
}

export function listMemories(
  options: {
    projectId?: string | null;
    kind?: MemoryKind;
    pinnedOnly?: boolean;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Memory[] {
  const db = getDb();
  const filters = [];
  if (!options.includeArchived) filters.push(eq(memories.archived, false));
  if (options.projectId !== undefined) {
    filters.push(
      options.projectId === null
        ? sql`${memories.projectId} IS NULL`
        : eq(memories.projectId, options.projectId),
    );
  }
  if (options.kind) filters.push(eq(memories.kind, options.kind));
  if (options.pinnedOnly) filters.push(eq(memories.pinned, true));

  return db
    .select()
    .from(memories)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(memories.pinned), desc(memories.createdAt))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0)
    .all();
}

/** Typed edge between two memories; powers the related-memories rail. */
export function linkMemories(fromId: string, toId: string, relation = 'related'): void {
  if (fromId === toId) return;
  getDb()
    .insert(memoryLinks)
    .values({ id: createId('link'), fromId, toId, relation, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function getLinkedMemories(id: string): Memory[] {
  const db = getDb();
  const links = db
    .select()
    .from(memoryLinks)
    .where(sql`${memoryLinks.fromId} = ${id} OR ${memoryLinks.toId} = ${id}`)
    .all();

  const otherIds = links.map((l) => (l.fromId === id ? l.toId : l.fromId));
  if (otherIds.length === 0) return [];

  return db.select().from(memories).where(inArray(memories.id, otherIds)).all();
}

/**
 * Re-embeds memories whose vectors came from the lexical fallback.
 *
 * Run after installing a real embedding model: it upgrades everything captured
 * while offline without the user losing any memories.
 */
export async function reembedStaleMemories(batchSize = 64): Promise<{ updated: number }> {
  const db = getDb();
  const stale = db
    .select()
    .from(memories)
    .where(sql`${memories.embeddingModel} IS NULL OR ${memories.embeddingModel} LIKE '%:lexical'`)
    .limit(batchSize)
    .all();

  if (stale.length === 0) return { updated: 0 };

  const { vectors, model, dim, isSemantic } = await embed(stale.map((m) => m.content));
  // Still on the fallback — nothing to upgrade to, so leave the rows alone.
  if (!isSemantic) return { updated: 0 };

  db.transaction((tx) => {
    stale.forEach((memory, index) => {
      tx.update(memories)
        .set({
          embedding: toBlob(vectors[index]),
          embeddingModel: model,
          embeddingDim: dim,
          updatedAt: Date.now(),
        })
        .where(eq(memories.id, memory.id))
        .run();
    });
  });

  invalidateVectorCache();
  return { updated: stale.length };
}

/** First sentence or clause, capped — used when the extractor omits a title. */
function deriveTitle(content: string): string {
  const firstSentence = content.split(/(?<=[.!?])\s/)[0] ?? content;
  const clean = firstSentence.replace(/\s+/g, ' ').trim();
  return clean.length > 72 ? `${clean.slice(0, 69)}…` : clean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

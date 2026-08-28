/** GET /api/memories — list or search. POST — create manually. */
import { z } from 'zod';

import { createMemory, listMemories, searchMemories } from '@/lib/memory';
import { boolParam, handle, parseBody, parseQuery } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuery = z.object({
  q: z.string().optional(),
  projectId: z.string().optional(),
  kind: z
    .enum(['fact', 'preference', 'event', 'entity', 'instruction', 'insight', 'summary'])
    .optional(),
  pinned: z.string().optional(),
  archived: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
  offset: z.coerce.number().min(0).default(0),
});

export async function GET(request: Request) {
  return handle(async () => {
    const query = parseQuery(request, listQuery);

    // A query means hybrid retrieval; no query means a plain listing.
    if (query.q?.trim()) {
      const results = await searchMemories(query.q, {
        limit: query.limit,
        projectId: query.projectId ?? null,
        includeArchived: boolParam(query.archived),
      });

      return {
        memories: results.map((r) => ({ ...r.memory, score: r.score, reason: r.reason })),
        query: query.q,
      };
    }

    const rows = listMemories({
      projectId: query.projectId,
      kind: query.kind,
      pinnedOnly: boolParam(query.pinned),
      includeArchived: boolParam(query.archived),
      limit: query.limit,
      offset: query.offset,
    });

    return { memories: rows };
  });
}

const createSchema = z.object({
  content: z.string().min(3).max(4000),
  title: z.string().max(160).optional(),
  kind: z
    .enum(['fact', 'preference', 'event', 'entity', 'instruction', 'insight', 'summary'])
    .optional(),
  importance: z.number().min(0).max(1).optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, createSchema);
    const result = await createMemory({ ...input, source: 'manual' });
    return { memory: result.memory, deduplicated: result.deduplicated };
  });
}

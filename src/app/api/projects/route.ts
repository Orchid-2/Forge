/** GET /api/projects — list with conversation counts. POST — create. */
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { activity, conversations, memories, projects } from '@/db/schema';
import { createId } from '@/lib/ids';
import { boolParam, handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(async () => {
    const includeArchived = boolParam(
      new URL(request.url).searchParams.get('archived') ?? undefined,
    );
    const db = getDb();

    const rows = db
      .select()
      .from(projects)
      .orderBy(desc(projects.pinned), desc(projects.updatedAt))
      .all();

    // Two grouped counts beat N+1 queries once a user has a few dozen projects.
    const conversationCounts = db
      .select({ projectId: conversations.projectId, count: sql<number>`count(*)` })
      .from(conversations)
      .where(eq(conversations.archived, false))
      .groupBy(conversations.projectId)
      .all();

    const memoryCounts = db
      .select({ projectId: memories.projectId, count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.archived, false))
      .groupBy(memories.projectId)
      .all();

    const conversationMap = new Map(conversationCounts.map((r) => [r.projectId, r.count]));
    const memoryMap = new Map(memoryCounts.map((r) => [r.projectId, r.count]));

    const enriched = rows
      .filter((p) => includeArchived || !p.archived)
      .map((project) => ({
        ...project,
        conversationCount: conversationMap.get(project.id) ?? 0,
        memoryCount: memoryMap.get(project.id) ?? 0,
      }));

    return { projects: enriched };
  });
}

export const projectInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  systemPrompt: z.string().default(''),
  defaultProfileId: z.string().nullable().optional(),
  defaultProvider: z.enum(['ollama', 'llamacpp', 'openai-compat']).nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  memoryScoped: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, projectInput);
    const db = getDb();
    const now = Date.now();

    const project = db
      .insert(projects)
      .values({ ...input, id: createId('proj'), createdAt: now, updatedAt: now })
      .returning()
      .get();

    db.insert(activity)
      .values({
        id: createId('act'),
        type: 'project.created',
        title: project.name,
        entityId: project.id,
        createdAt: now,
      })
      .run();

    return { project };
  });
}

/** GET /api/conversations — list. POST — create. */
import { and, desc, eq, like, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { conversations, projects } from '@/db/schema';
import { createConversation } from '@/lib/chat/pipeline';
import { boolParam, handle, parseBody, parseQuery } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuery = z.object({
  projectId: z.string().optional(),
  archived: z.string().optional(),
  pinned: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(200),
});

export async function GET(request: Request) {
  return handle(async () => {
    const query = parseQuery(request, listQuery);
    const db = getDb();

    const filters: SQL[] = [eq(conversations.archived, boolParam(query.archived) ?? false)];
    if (query.projectId) filters.push(eq(conversations.projectId, query.projectId));
    if (boolParam(query.pinned)) filters.push(eq(conversations.pinned, true));
    if (query.q) {
      // Title match only — full-text search across message bodies is a separate,
      // heavier endpoint (/api/search).
      filters.push(like(conversations.title, `%${query.q}%`) as SQL);
    }

    const rows = db
      .select()
      .from(conversations)
      .where(and(...filters))
      .orderBy(desc(conversations.pinned), desc(conversations.lastMessageAt))
      .limit(query.limit)
      .all();

    return { conversations: rows };
  });
}

const createSchema = z.object({
  title: z.string().optional(),
  projectId: z.string().nullable().optional(),
  profileId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const body = await parseBody(request, createSchema);
    const conversation = createConversation(body);

    const project = conversation.projectId
      ? getDb().select().from(projects).where(eq(projects.id, conversation.projectId)).get()
      : null;

    return { conversation, project };
  });
}

/** DELETE /api/conversations?archived — bulk clear of archived conversations. */
export async function DELETE(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const onlyArchived = boolParam(url.searchParams.get('archived') ?? undefined);

    const db = getDb();
    const target = onlyArchived
      ? eq(conversations.archived, true)
      : or(eq(conversations.archived, true), eq(conversations.archived, false));

    const removed = db.delete(conversations).where(target).returning({ id: conversations.id }).all();
    return { deleted: removed.length };
  });
}

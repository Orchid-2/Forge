/** GET / PATCH / DELETE a single conversation. */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { conversations, messages, messageVersions } from '@/db/schema';
import { handle, notFound, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();

    const conversation = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!conversation) throw notFound('Conversation');

    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.seq))
      .all();

    // Version history is only needed for messages that actually have alternates.
    const withVersions = rows.filter((m) => m.versionCount > 1).map((m) => m.id);
    const versions = withVersions.length
      ? db.select().from(messageVersions).orderBy(asc(messageVersions.version)).all()
        .filter((v) => withVersions.includes(v.messageId))
      : [];

    return { conversation, messages: rows, versions };
  });
}

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().nullable().optional(),
  profileId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, patchSchema);
    const db = getDb();

    const updated = db
      .update(conversations)
      .set({
        ...patch,
        provider: patch.provider as never,
        // A hand-edited title should stop the auto-titler overwriting it.
        ...(patch.title ? { titleGenerated: true } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(conversations.id, id))
      .returning()
      .get();

    if (!updated) throw notFound('Conversation');

    // Archiving distils the transcript into a durable memory so its substance
    // survives even if the conversation is never reopened.
    if (patch.archived === true) {
      void import('@/lib/memory').then(({ archiveConversationToMemory }) =>
        archiveConversationToMemory(updated).catch(() => {}),
      );
    }

    return { conversation: updated };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    // Messages cascade via the foreign key.
    const removed = getDb()
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id })
      .get();

    if (!removed) throw notFound('Conversation');
    return { deleted: removed.id };
  });
}

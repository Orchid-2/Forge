/** PATCH / DELETE a single message. Used for pin, inline edit and delete. */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { conversations, messages, messageVersions } from '@/db/schema';
import { handle, notFound, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  content: z.string().optional(),
  pinned: z.boolean().optional(),
  /** Switch which stored version is shown, for the "‹ 2 / 3 ›" pager. */
  activeVersion: z.number().int().min(0).optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, patchSchema);
    const db = getDb();

    const current = db.select().from(messages).where(eq(messages.id, id)).get();
    if (!current) throw notFound('Message');

    // Switching version swaps the stored alternate into the live row, keeping
    // the displaced text as a version of its own.
    if (patch.activeVersion !== undefined && patch.activeVersion !== current.activeVersion) {
      const target = db
        .select()
        .from(messageVersions)
        .where(
          and(eq(messageVersions.messageId, id), eq(messageVersions.version, patch.activeVersion)),
        )
        .get();

      if (target) {
        db.transaction((tx) => {
          tx.insert(messageVersions)
            .values({
              id: `${id}_v${current.activeVersion}`,
              messageId: id,
              version: current.activeVersion,
              content: current.content,
              reasoning: current.reasoning,
              toolCalls: current.toolCalls,
              model: current.model,
              promptTokens: current.promptTokens,
              completionTokens: current.completionTokens,
              createdAt: current.createdAt,
            })
            .onConflictDoNothing()
            .run();

          tx.update(messages)
            .set({
              content: target.content,
              reasoning: target.reasoning,
              toolCalls: target.toolCalls,
              activeVersion: patch.activeVersion!,
              updatedAt: Date.now(),
            })
            .where(eq(messages.id, id))
            .run();
        });

        return { message: db.select().from(messages).where(eq(messages.id, id)).get() };
      }
    }

    const updated = db
      .update(messages)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(messages.id, id))
      .returning()
      .get();

    return { message: updated };
  });
}

/**
 * DELETE /api/messages/:id
 *
 * `?cascade` also removes every later message. Deleting a user turn without
 * cascade would leave replies to a question that no longer exists, so the
 * client passes it whenever removing a user message.
 */
export async function DELETE(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const cascade = new URL(request.url).searchParams.has('cascade');
    const db = getDb();

    const target = db.select().from(messages).where(eq(messages.id, id)).get();
    if (!target) throw notFound('Message');

    db.transaction((tx) => {
      if (cascade) {
        tx.delete(messages)
          .where(
            and(eq(messages.conversationId, target.conversationId), gt(messages.seq, target.seq)),
          )
          .run();
      }
      tx.delete(messages).where(eq(messages.id, id)).run();
    });

    const remaining = db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.conversationId, target.conversationId))
      .get();

    db.update(conversations)
      .set({ messageCount: remaining?.count ?? 0, updatedAt: Date.now() })
      .where(eq(conversations.id, target.conversationId))
      .run();

    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, target.conversationId))
      .orderBy(asc(messages.seq))
      .all();

    return { deleted: id, messages: rows };
  });
}

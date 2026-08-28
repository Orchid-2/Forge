/**
 * GET /api/search — global search across conversations, messages and memories.
 *
 * Backs the command palette. Messages use the FTS5 index; conversations and
 * memories use their own paths. Results are capped tightly because this runs on
 * every keystroke.
 */
import { desc, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, getSqlite } from '@/db';
import { conversations, messages } from '@/db/schema';
import { searchMemories } from '@/lib/memory';
import { handle, parseQuery } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().min(1).max(50).default(8),
});

export async function GET(request: Request) {
  return handle(async () => {
    const { q, limit } = parseQuery(request, query);
    const term = q.trim();

    if (term.length < 2) {
      return { conversations: [], messages: [], memories: [] };
    }

    const db = getDb();

    const conversationHits = db
      .select({
        id: conversations.id,
        title: conversations.title,
        lastMessageAt: conversations.lastMessageAt,
        projectId: conversations.projectId,
      })
      .from(conversations)
      .where(like(conversations.title, `%${term}%`))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit)
      .all();

    /* ── Message bodies via FTS5 ───────────────────────────────────────────── */
    let messageHits: Array<{
      id: string;
      conversationId: string;
      content: string;
      role: string;
      createdAt: number;
      conversationTitle?: string;
    }> = [];

    try {
      // Quote the term so FTS5 treats it as text, never as query syntax. The
      // trailing `*` makes it a prefix search, which is what feels right while
      // someone is still typing.
      const ftsQuery = `"${term.replace(/"/g, '')}"*`;

      const ids = (
        getSqlite()
          .prepare('SELECT id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?')
          .all(ftsQuery, limit) as Array<{ id: string }>
      ).map((r) => r.id);

      if (ids.length > 0) {
        const rows = db.select().from(messages).where(inArray(messages.id, ids)).all();
        const titles = new Map(
          db
            .select({ id: conversations.id, title: conversations.title })
            .from(conversations)
            .where(inArray(conversations.id, rows.map((r) => r.conversationId)))
            .all()
            .map((c) => [c.id, c.title]),
        );

        // Preserve FTS rank ordering, which the IN query does not guarantee.
        const byId = new Map(rows.map((r) => [r.id, r]));
        messageHits = ids
          .map((id) => byId.get(id))
          .filter((row): row is NonNullable<typeof row> => row !== undefined)
          .map((row) => ({
            id: row.id,
            conversationId: row.conversationId,
            content: row.content,
            role: row.role,
            createdAt: row.createdAt,
            conversationTitle: titles.get(row.conversationId),
          }));
      }
    } catch {
      // FTS unavailable or query rejected: fall back to a LIKE scan so search
      // still returns something useful.
      messageHits = db
        .select()
        .from(messages)
        .where(or(like(messages.content, `%${term}%`)))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .all()
        .map((row) => ({
          id: row.id,
          conversationId: row.conversationId,
          content: row.content,
          role: row.role,
          createdAt: row.createdAt,
        }));
    }

    const memoryHits = await searchMemories(term, { limit });

    return {
      conversations: conversationHits,
      messages: messageHits,
      memories: memoryHits.map((m) => ({
        id: m.memory.id,
        title: m.memory.title,
        content: m.memory.content,
        kind: m.memory.kind,
        score: m.score,
      })),
    };
  });
}

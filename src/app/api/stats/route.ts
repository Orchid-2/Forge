/**
 * GET /api/stats — everything the dashboard renders.
 *
 * One endpoint rather than six: the dashboard needs all of it at once, and a
 * single round trip keeps the page snappy. All aggregation happens in SQLite,
 * which is far faster than pulling rows into JS to count them.
 */
import { and, desc, eq, gte, sql, type AnyColumn } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { activity, conversations, goals, memories, messages, models, projects } from '@/db/schema';
import { handle, parseQuery } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({
  /** Window for the time-series charts. */
  days: z.coerce.number().min(7).max(365).default(30),
});

export async function GET(request: Request) {
  return handle(async () => {
    const { days } = parseQuery(request, query);
    const db = getDb();

    const since = Date.now() - days * 86_400_000;

    /* ── Totals ────────────────────────────────────────────────────────────── */
    const totals = {
      conversations:
        db
          .select({ count: sql<number>`count(*)` })
          .from(conversations)
          .get()?.count ?? 0,
      messages:
        db
          .select({ count: sql<number>`count(*)` })
          .from(messages)
          .get()?.count ?? 0,
      memories:
        db
          .select({ count: sql<number>`count(*)` })
          .from(memories)
          .where(eq(memories.archived, false))
          .get()?.count ?? 0,
      projects:
        db
          .select({ count: sql<number>`count(*)` })
          .from(projects)
          .where(eq(projects.archived, false))
          .get()?.count ?? 0,
      tokens:
        db
          .select({
            total: sql<number>`COALESCE(SUM(${messages.promptTokens} + ${messages.completionTokens}), 0)`,
          })
          .from(messages)
          .get()?.total ?? 0,
      pinnedMemories:
        db
          .select({ count: sql<number>`count(*)` })
          .from(memories)
          .where(and(eq(memories.pinned, true), eq(memories.archived, false)))
          .get()?.count ?? 0,
      models:
        db
          .select({ count: sql<number>`count(*)` })
          .from(models)
          .get()?.count ?? 0,
    };

    /* ── Daily activity ────────────────────────────────────────────────────── */
    // `unixepoch` + 'localtime' groups by the user's day, not UTC — otherwise
    // late-night activity lands on tomorrow's bar.
    const dayExpression = (column: AnyColumn) =>
      sql<string>`strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime')`;

    const messageSeries = db
      .select({
        day: dayExpression(messages.createdAt),
        count: sql<number>`count(*)`,
        tokens: sql<number>`COALESCE(SUM(${messages.promptTokens} + ${messages.completionTokens}), 0)`,
      })
      .from(messages)
      .where(gte(messages.createdAt, since))
      .groupBy(dayExpression(messages.createdAt))
      .all();

    const memorySeries = db
      .select({
        day: dayExpression(memories.createdAt),
        count: sql<number>`count(*)`,
      })
      .from(memories)
      .where(gte(memories.createdAt, since))
      .groupBy(dayExpression(memories.createdAt))
      .all();

    // Fill gaps so the chart shows a continuous axis rather than skipping quiet
    // days, and compute the running memory total for the growth line.
    const messageByDay = new Map(messageSeries.map((r) => [r.day, r]));
    const memoryByDay = new Map(memorySeries.map((r) => [r.day, r.count]));

    const priorMemories =
      db
        .select({ count: sql<number>`count(*)` })
        .from(memories)
        .where(sql`${memories.createdAt} < ${since}`)
        .get()?.count ?? 0;

    let cumulative = priorMemories;
    const series: Array<{
      day: string;
      messages: number;
      tokens: number;
      memories: number;
      memoryTotal: number;
    }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const created = memoryByDay.get(key) ?? 0;
      cumulative += created;

      series.push({
        day: key,
        messages: messageByDay.get(key)?.count ?? 0,
        tokens: messageByDay.get(key)?.tokens ?? 0,
        memories: created,
        memoryTotal: cumulative,
      });
    }

    /* ── Breakdowns ────────────────────────────────────────────────────────── */
    const memoryKinds = db
      .select({ kind: memories.kind, count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.archived, false))
      .groupBy(memories.kind)
      .orderBy(desc(sql`count(*)`))
      .all();

    const topModels = db
      .select({
        model: messages.model,
        provider: messages.provider,
        count: sql<number>`count(*)`,
        tokens: sql<number>`COALESCE(SUM(${messages.completionTokens}), 0)`,
      })
      .from(messages)
      .where(and(eq(messages.role, 'assistant'), sql`${messages.model} IS NOT NULL`))
      .groupBy(messages.model)
      .orderBy(desc(sql`count(*)`))
      .limit(6)
      .all();

    /* ── Recent activity and goals ─────────────────────────────────────────── */
    const recentActivity = db
      .select()
      .from(activity)
      .orderBy(desc(activity.createdAt))
      .limit(12)
      .all();

    const recentConversations = db
      .select({
        id: conversations.id,
        title: conversations.title,
        messageCount: conversations.messageCount,
        lastMessageAt: conversations.lastMessageAt,
        projectId: conversations.projectId,
      })
      .from(conversations)
      .where(eq(conversations.archived, false))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(6)
      .all();

    const activeGoals = db
      .select()
      .from(goals)
      .where(eq(goals.archived, false))
      .orderBy(goals.sortOrder)
      .all();

    /* ── Derived headline numbers ──────────────────────────────────────────── */
    const activeDays = series.filter((d) => d.messages > 0).length;

    // Current streak: consecutive active days counting back from today.
    let streak = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].messages > 0) streak++;
      // Today being quiet does not break a streak that is still live.
      else if (i !== series.length - 1) break;
    }

    return {
      totals,
      series,
      memoryKinds,
      topModels,
      recentActivity,
      recentConversations,
      goals: activeGoals,
      derived: {
        activeDays,
        streak,
        avgMessagesPerDay: activeDays
          ? Math.round(series.reduce((sum, d) => sum + d.messages, 0) / activeDays)
          : 0,
        windowDays: days,
      },
    };
  });
}

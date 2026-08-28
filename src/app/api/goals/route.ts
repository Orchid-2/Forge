/** GET /api/goals — progress trackers with their recent entries. POST — create. */
import { desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { goalEntries, goals } from '@/db/schema';
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

    const rows = db.select().from(goals).orderBy(goals.sortOrder, desc(goals.createdAt)).all();

    // 90 days of entries is enough for every sparkline the dashboard draws.
    const since = Date.now() - 90 * 86_400_000;
    const entries = db.select().from(goalEntries).where(gte(goalEntries.createdAt, since)).all();

    const byGoal = new Map<string, typeof entries>();
    for (const entry of entries) {
      const list = byGoal.get(entry.goalId) ?? [];
      list.push(entry);
      byGoal.set(entry.goalId, list);
    }

    return {
      goals: rows
        .filter((g) => includeArchived || !g.archived)
        .map((goal) => ({ ...goal, entries: byGoal.get(goal.id) ?? [] })),
    };
  });
}

export const goalInput = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(300).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  kind: z.enum(['counter', 'streak', 'target']).optional(),
  unit: z.string().max(20).optional(),
  target: z.number().min(0).optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, goalInput);
    const db = getDb();
    const now = Date.now();

    const last = db.select().from(goals).orderBy(desc(goals.sortOrder)).get();

    const goal = db
      .insert(goals)
      .values({
        ...input,
        id: createId('goal'),
        sortOrder: (last?.sortOrder ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return { goal: { ...goal, entries: [] } };
  });
}

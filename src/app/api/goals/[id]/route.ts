/** PATCH / DELETE a goal. POST logs progress against it. */
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { activity, goalEntries, goals } from '@/db/schema';
import { createId } from '@/lib/ids';
import { dayKey } from '@/lib/utils';
import { handle, notFound, parseBody } from '@/lib/api';
import { goalPatch } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const logSchema = z.object({
  value: z.number().default(1),
  note: z.string().max(200).optional(),
});

/** POST /api/goals/:id — record progress and recompute the roll-ups. */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const { value, note } = await parseBody(request, logSchema);
    const db = getDb();

    const goal = db.select().from(goals).where(eq(goals.id, id)).get();
    if (!goal) throw notFound('Goal');

    const now = Date.now();
    const today = dayKey();

    db.insert(goalEntries)
      .values({
        id: createId('entry'),
        goalId: id,
        value,
        note: note ?? null,
        day: today,
        createdAt: now,
      })
      .run();

    const total =
      db
        .select({ sum: sql<number>`COALESCE(SUM(${goalEntries.value}), 0)` })
        .from(goalEntries)
        .where(eq(goalEntries.goalId, id))
        .get()?.sum ?? 0;

    const updated = db
      .update(goals)
      .set({ current: total, streak: computeStreak(id), updatedAt: now })
      .where(eq(goals.id, id))
      .returning()
      .get();

    db.insert(activity)
      .values({
        id: createId('act'),
        type: 'goal.logged',
        title: goal.title,
        detail: `${value > 0 ? '+' : ''}${value}${goal.unit ? ` ${goal.unit}` : ''}`,
        entityId: id,
        createdAt: now,
      })
      .run();

    return { goal: updated };
  });
}

/**
 * Consecutive days with at least one entry, counting back from today.
 *
 * Today not being logged yet does not break the streak — it only breaks once a
 * whole day passes with nothing recorded.
 */
function computeStreak(goalId: string): number {
  const db = getDb();
  const days = new Set(
    db
      .select({ day: goalEntries.day })
      .from(goalEntries)
      .where(eq(goalEntries.goalId, goalId))
      .orderBy(desc(goalEntries.day))
      .all()
      .map((r) => r.day),
  );

  let streak = 0;
  const cursor = new Date();

  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  while (days.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, goalPatch);

    const updated = getDb()
      .update(goals)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(goals.id, id))
      .returning()
      .get();

    if (!updated) throw notFound('Goal');
    return { goal: updated };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const removed = getDb()
      .delete(goals)
      .where(eq(goals.id, id))
      .returning({ id: goals.id })
      .get();

    if (!removed) throw notFound('Goal');
    return { deleted: id };
  });
}

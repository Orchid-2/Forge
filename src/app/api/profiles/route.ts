/** GET /api/profiles — list personas. POST — create. */
import { asc, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { profiles } from '@/db/schema';
import { createId } from '@/lib/ids';
import { boolParam, handle, parseBody } from '@/lib/api';
import { profileInput } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(async () => {
    const includeArchived = boolParam(
      new URL(request.url).searchParams.get('archived') ?? undefined,
    );

    const rows = getDb()
      .select()
      .from(profiles)
      .orderBy(asc(profiles.sortOrder), asc(profiles.name))
      .all();

    return { profiles: includeArchived ? rows : rows.filter((p) => !p.archived) };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, profileInput);
    const db = getDb();
    const now = Date.now();

    // New personas go to the end of the list unless placed explicitly.
    const last = db.select().from(profiles).orderBy(desc(profiles.sortOrder)).get();

    const profile = db
      .insert(profiles)
      .values({
        ...input,
        id: createId('prof'),
        sortOrder: input.sortOrder ?? (last?.sortOrder ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return { profile };
  });
}

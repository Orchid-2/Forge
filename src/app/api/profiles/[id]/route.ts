/** GET / PATCH / DELETE one persona. */
import { eq, ne, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { conversations, profiles } from '@/db/schema';
import { ApiError, handle, notFound, parseBody } from '@/lib/api';
import { profileInput } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const patchSchema = profileInput.partial().extend({
  isDefault: profileInput.shape.memoryRead.optional(),
  archived: profileInput.shape.memoryRead.optional(),
});

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const profile = getDb().select().from(profiles).where(eq(profiles.id, id)).get();
    if (!profile) throw notFound('Profile');

    const usage = getDb()
      .select({ count: sql<number>`count(*)` })
      .from(conversations)
      .where(eq(conversations.profileId, id))
      .get();

    return { profile, conversationCount: usage?.count ?? 0 };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, patchSchema);
    const db = getDb();

    // Exactly one profile is the default, so promoting one demotes the rest.
    if (patch.isDefault === true) {
      db.update(profiles).set({ isDefault: false }).where(ne(profiles.id, id)).run();
    }

    const updated = db
      .update(profiles)
      .set({ ...patch, provider: patch.provider as never, updatedAt: Date.now() })
      .where(eq(profiles.id, id))
      .returning()
      .get();

    if (!updated) throw notFound('Profile');
    return { profile: updated };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();

    const remaining = db.select().from(profiles).all();
    if (remaining.length <= 1) {
      throw new ApiError('Cannot delete your only persona.', 409);
    }

    const target = remaining.find((p) => p.id === id);
    if (!target) throw notFound('Profile');

    // Never leave the app without a default persona.
    if (target.isDefault) {
      const successor = remaining.find((p) => p.id !== id);
      if (successor) {
        db.update(profiles).set({ isDefault: true }).where(eq(profiles.id, successor.id)).run();
      }
    }

    // Conversations keep their history; the FK nulls their profile reference.
    db.delete(profiles).where(eq(profiles.id, id)).run();
    return { deleted: id };
  });
}

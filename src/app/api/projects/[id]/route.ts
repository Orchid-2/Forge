/** GET / PATCH / DELETE one project. */
import { desc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { conversations, memories, projects } from '@/db/schema';
import { handle, notFound, parseBody } from '@/lib/api';
import { projectInput } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const patchSchema = projectInput.partial().extend({
  archived: projectInput.shape.pinned.optional(),
});

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const db = getDb();

    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw notFound('Project');

    const projectConversations = db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .orderBy(desc(conversations.pinned), desc(conversations.lastMessageAt))
      .all();

    const projectMemories = db
      .select()
      .from(memories)
      .where(eq(memories.projectId, id))
      .orderBy(desc(memories.pinned), desc(memories.createdAt))
      .limit(50)
      .all();

    return { project, conversations: projectConversations, memories: projectMemories };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, patchSchema);

    const updated = getDb()
      .update(projects)
      .set({ ...patch, defaultProvider: patch.defaultProvider as never, updatedAt: Date.now() })
      .where(eq(projects.id, id))
      .returning()
      .get();

    if (!updated) throw notFound('Project');
    return { project: updated };
  });
}

/**
 * DELETE /api/projects/:id
 *
 * Conversations survive by design — they detach to the top level rather than
 * being destroyed with the project. `?purge` deletes them too, and is only
 * sent after an explicit confirmation in the UI.
 */
export async function DELETE(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const purge = new URL(request.url).searchParams.has('purge');
    const db = getDb();

    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) throw notFound('Project');

    db.transaction((tx) => {
      if (purge) {
        tx.delete(conversations).where(eq(conversations.projectId, id)).run();
      } else {
        tx.update(conversations)
          .set({ projectId: null, updatedAt: Date.now() })
          .where(eq(conversations.projectId, id))
          .run();
      }
      // Project-scoped memories cascade via the foreign key.
      tx.delete(projects).where(eq(projects.id, id)).run();
    });

    return { deleted: id, purged: purge };
  });
}

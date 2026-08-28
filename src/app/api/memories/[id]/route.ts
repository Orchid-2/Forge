/** GET / PATCH / DELETE one memory. */
import { z } from 'zod';

import { deleteMemory, getLinkedMemories, getMemory, updateMemory } from '@/lib/memory';
import { handle, notFound, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const memory = getMemory(id);
    if (!memory) throw notFound('Memory');
    return { memory, linked: getLinkedMemories(id) };
  });
}

const patchSchema = z.object({
  content: z.string().min(3).max(4000).optional(),
  title: z.string().max(160).optional(),
  kind: z
    .enum(['fact', 'preference', 'event', 'entity', 'instruction', 'insight', 'summary'])
    .optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, patchSchema);

    // Editing the text re-embeds the memory; `updateMemory` handles that.
    const memory = await updateMemory(id, patch);
    if (!memory) throw notFound('Memory');

    return { memory };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    if (!getMemory(id)) throw notFound('Memory');
    deleteMemory(id);
    return { deleted: id };
  });
}

/** GET model detail, PATCH favourite, DELETE from backend and registry. */
import { z } from 'zod';

import { describeModel, removeModel, setFavorite } from '@/lib/models/registry';
import { handle, notFound, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const model = await describeModel(id);
    if (!model) throw notFound('Model');
    return { model };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const { favorite } = await parseBody(request, z.object({ favorite: z.boolean() }));
    setFavorite(id, favorite);
    return { id, favorite };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    await removeModel(id);
    return { deleted: id };
  });
}

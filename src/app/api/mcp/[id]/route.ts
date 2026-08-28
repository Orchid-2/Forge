/** PATCH / DELETE an MCP server. POST re-tests its connection. */
import { eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { mcpServers } from '@/db/schema';
import { disconnectServer, refreshServer } from '@/lib/mcp/client';
import { handle, notFound, parseBody } from '@/lib/api';
import { mcpInput } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** POST /api/mcp/:id — reconnect and re-discover tools. */
export async function POST(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;

    // Drop any pooled connection first so a config change actually takes effect.
    await disconnectServer(id).catch(() => {});
    const result = await refreshServer(id);

    const server = getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!server) throw notFound('MCP server');

    return { server, connection: result };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await parseBody(request, mcpInput.partial());

    const updated = getDb()
      .update(mcpServers)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(mcpServers.id, id))
      .returning()
      .get();

    if (!updated) throw notFound('MCP server');

    // Any config change invalidates the live connection.
    await disconnectServer(id).catch(() => {});

    return { server: updated };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    await disconnectServer(id).catch(() => {});

    const removed = getDb()
      .delete(mcpServers)
      .where(eq(mcpServers.id, id))
      .returning({ id: mcpServers.id })
      .get();

    if (!removed) throw notFound('MCP server');
    return { deleted: id };
  });
}

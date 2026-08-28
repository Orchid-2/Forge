/** GET /api/mcp — configured servers. POST — add one. */
import { desc } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { mcpServers } from '@/db/schema';
import { createId } from '@/lib/ids';
import { refreshServer } from '@/lib/mcp/client';
import { handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({
    servers: getDb().select().from(mcpServers).orderBy(desc(mcpServers.createdAt)).all(),
  }));
}

export const mcpInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, mcpInput);
    const db = getDb();
    const now = Date.now();

    const server = db
      .insert(mcpServers)
      .values({ ...input, id: createId('mcp'), createdAt: now, updatedAt: now })
      .returning()
      .get();

    // Connect immediately so the user sees whether their config works, and so
    // the tool list is populated for the persona editor.
    const result = await refreshServer(server.id);

    return {
      server: db.select().from(mcpServers).all().find((s) => s.id === server.id) ?? server,
      connection: result,
    };
  });
}

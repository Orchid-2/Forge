/**
 * Obsidian vault.
 *   GET   status of the configured vault
 *   POST  sync — everything, or one conversation / memory
 */
import { z } from 'zod';

import { checkVault, syncAllToVault, syncConversationToVault, syncMemoryToVault } from '@/lib/integrations/obsidian';
import { handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({ vault: await checkVault() }));
}

const syncSchema = z.object({
  conversationId: z.string().optional(),
  memoryId: z.string().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, syncSchema).catch(() => ({}) as z.infer<typeof syncSchema>);

    if (input.conversationId) {
      const written = await syncConversationToVault(input.conversationId);
      return { written, path: written };
    }

    if (input.memoryId) {
      const written = await syncMemoryToVault(input.memoryId);
      return { written, path: written };
    }

    return { summary: await syncAllToVault() };
  });
}

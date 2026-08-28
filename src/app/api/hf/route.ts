/**
 * Hugging Face backup.
 *   GET   connection status
 *   POST  { action: "push" | "pull" }
 */
import { z } from 'zod';

import { checkHub, pullFromHub, syncAllToHub } from '@/lib/integrations/huggingface';
import { handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({ hub: await checkHub() }));
}

const actionSchema = z.object({
  action: z.enum(['push', 'pull']).default('push'),
  /** Re-upload everything, ignoring the content-hash skip. */
  force: z.boolean().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const { action, force } = await parseBody(request, actionSchema);

    if (action === 'pull') {
      return { action, summary: await pullFromHub() };
    }

    return { action, summary: await syncAllToHub({ force }) };
  });
}

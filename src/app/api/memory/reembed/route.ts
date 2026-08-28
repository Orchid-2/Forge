/**
 * POST /api/memory/reembed — upgrade memories captured with the lexical
 * fallback embedder once a real embedding model becomes available.
 */
import { reembedStaleMemories } from '@/lib/memory';
import { handle } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return handle(async () => {
    // Batched: re-embedding thousands of memories in one request would time
    // out, so the client calls until `updated` comes back zero.
    let total = 0;
    for (let batch = 0; batch < 8; batch++) {
      const { updated } = await reembedStaleMemories(64);
      total += updated;
      if (updated === 0) break;
    }
    return { updated: total };
  });
}

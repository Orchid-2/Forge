/** GET /api/providers — health of every configured backend. */
import { probeProviders } from '@/lib/llm';
import { handle } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({ providers: await probeProviders() }));
}

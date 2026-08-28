/** GET /api/models — registry, optionally refreshed from live backends. */
import { listAdapters, listModels, refreshRegistry } from '@/lib/models/registry';
import { boolParam, handle } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;

    // `?refresh` re-probes the backends. It costs a round trip per backend, so
    // it is opt-in rather than automatic on every list.
    if (boolParam(params.get('refresh') ?? undefined)) {
      await refreshRegistry().catch(() => {});
    }

    return {
      models: listModels({ includeMissing: boolParam(params.get('missing') ?? undefined) }),
      adapters: listAdapters(),
    };
  });
}

/** POST /api/models — force a registry refresh. */
export async function POST() {
  return handle(async () => {
    const result = await refreshRegistry();
    return { ...result, models: listModels() };
  });
}

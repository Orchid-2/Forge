/**
 * POST /api/models/pull — stream an `ollama pull`.
 *
 * Ollama reports progress as NDJSON; we re-shape it into a smaller frame the
 * models page can render directly, and forward it as it arrives.
 */
import { z } from 'zod';

import { OllamaProvider, getProvider } from '@/lib/llm';
import { refreshRegistry } from '@/lib/models/registry';
import { ApiError, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ model: z.string().min(1) });

export async function POST(request: Request) {
  const { model } = await parseBody(request, bodySchema);

  const provider = getProvider('ollama');
  if (!(provider instanceof OllamaProvider)) {
    throw new ApiError('Pulling is only supported for the Ollama backend.', 400);
  }

  const encoder = new TextEncoder();
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (payload: unknown) => {
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          /* client gone */
        }
      };

      try {
        for await (const chunk of provider.pull(model, controller.signal)) {
          if (chunk.error) {
            send({ status: 'error', error: chunk.error });
            break;
          }
          send({
            status: chunk.status ?? 'working',
            completed: chunk.completed ?? 0,
            total: chunk.total ?? 0,
          });
        }

        // The new model should appear in the switcher without a manual refresh.
        await refreshRegistry().catch(() => {});
        send({ status: 'done' });
      } catch (error) {
        send({
          status: 'error',
          error: error instanceof Error ? error.message : 'Pull failed.',
        });
      } finally {
        try {
          streamController.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

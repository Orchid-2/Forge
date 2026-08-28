/**
 * POST /api/chat — streaming chat completion.
 *
 * Returns NDJSON of `ChatStreamEvent`s. The generator is drained inside a
 * `ReadableStream` so the client gets tokens as they are produced rather than
 * one buffered response at the end.
 */
import { z } from 'zod';

import { createConversation, runTurn } from '@/lib/chat/pipeline';
import { encodeEvent, type ChatStreamEvent } from '@/lib/chat/protocol';
import { ApiError, handle, json, parseBody } from '@/lib/api';

// Node runtime: the pipeline touches better-sqlite3 and possibly child
// processes for MCP, neither of which exist on the edge runtime.
export const runtime = 'nodejs';
// Streaming responses must never be cached or statically analysed.
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  conversationId: z.string().optional(),
  content: z.string().optional(),
  projectId: z.string().nullable().optional(),
  profileId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  regenerateMessageId: z.string().optional(),
  editMessageId: z.string().optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, bodySchema).catch((error) => {
    throw error;
  });

  // Sending with no conversation starts one — this is how "new chat" works
  // without an extra round trip before the first token.
  const conversationId =
    body.conversationId ??
    createConversation({
      projectId: body.projectId ?? null,
      profileId: body.profileId ?? null,
      provider: body.provider ?? null,
      model: body.model ?? null,
    }).id;

  const isNewTurn = Boolean(body.content?.trim());
  if (!isNewTurn && !body.regenerateMessageId && !body.editMessageId) {
    return handle(async () => {
      throw new ApiError('Nothing to send: provide content, or a message to regenerate or edit.');
    });
  }

  // Client disconnects (tab closed, stop pressed) abort generation so the
  // backend is not left generating into a void.
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (event: ChatStreamEvent) => {
        try {
          streamController.enqueue(encodeEvent(event));
        } catch {
          // Enqueue after close means the client is gone; nothing to do.
        }
      };

      try {
        for await (const event of runTurn({
          conversationId,
          userContent: body.content,
          regenerateMessageId: body.regenerateMessageId,
          editMessageId: body.editMessageId,
          signal: controller.signal,
        })) {
          send(event);
        }
      } catch (error) {
        send({
          t: 'error',
          message: error instanceof Error ? error.message : 'Generation failed.',
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
      // Tells nginx and friends not to buffer, which would defeat streaming.
      'X-Accel-Buffering': 'no',
      'X-Conversation-Id': conversationId,
    },
  });
}

/** GET is not meaningful here, but a clear 405 beats a confusing 404. */
export async function GET() {
  return json({ error: 'Use POST to send a message.' }, { status: 405 });
}

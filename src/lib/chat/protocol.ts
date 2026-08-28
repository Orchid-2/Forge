/**
 * Chat streaming wire protocol.
 *
 * Shared by the API route and the client store, so the two can never drift.
 * Deliberately not `server-only` — the browser imports these types.
 *
 * Frames are newline-delimited JSON rather than SSE. The client reads this with
 * a plain reader loop, and NDJSON avoids SSE's per-frame `data: ` overhead on a
 * stream that emits a frame per token.
 */

export type ChatStreamEvent =
  /** Sent once the assistant row exists, so the client can anchor its UI. */
  | { t: 'start'; messageId: string; conversationId: string; model: string; provider: string }
  /** Memories retrieved for this turn, shown as citations under the reply. */
  | { t: 'memories'; items: CitedMemory[] }
  | { t: 'text'; d: string }
  | { t: 'reasoning'; d: string }
  /** Emitted on every state change of a tool call: running → done or error. */
  | { t: 'tool'; call: StreamedToolCall }
  /** Auto-generated title, sent mid-stream so the sidebar updates live. */
  | { t: 'title'; title: string }
  | { t: 'usage'; promptTokens: number; completionTokens: number; durationMs: number }
  | { t: 'done'; messageId: string }
  | { t: 'error'; message: string; hint?: string };

export interface CitedMemory {
  id: string;
  title: string;
  content: string;
  kind: string;
  score: number;
}

export interface StreamedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: string;
  error?: string;
  durationMs?: number;
}

export function encodeEvent(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

/**
 * Reads an NDJSON stream into events.
 *
 * Chunk boundaries fall wherever the network puts them, so a partial line is
 * held back until the rest of it arrives.
 */
export async function* decodeEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as ChatStreamEvent;
        } catch {
          // A truncated frame is not worth killing the stream over.
        }
      }
    }

    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as ChatStreamEvent;
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Request body accepted by POST /api/chat. */
export interface ChatRequestBody {
  conversationId?: string;
  /** Text of the new user message. Omit when regenerating. */
  content?: string;
  projectId?: string | null;
  profileId?: string | null;
  provider?: string | null;
  model?: string | null;
  /** Regenerate the reply to an existing message rather than sending a new one. */
  regenerateMessageId?: string;
  /** Edit a user message in place, then regenerate everything after it. */
  editMessageId?: string;
}

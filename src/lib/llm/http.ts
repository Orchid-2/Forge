/**
 * Shared HTTP helpers for provider clients.
 *
 * Local backends fail in a small number of predictable ways (not running, model
 * not pulled, out of VRAM). Turning those into actionable messages here means
 * every provider gets good errors for free.
 */
import { ProviderError, type ProviderId } from './types';

/** Connection probes should fail fast; a dead port shouldn't hang the UI. */
export const PROBE_TIMEOUT_MS = 2500;

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  provider: ProviderId;
}

/**
 * fetch with a timeout that composes with an external abort signal.
 *
 * A user pressing "stop" and a request timing out both need to abort the same
 * connection, and `AbortSignal.any` is the only way to have two owners.
 */
export async function providerFetch(url: string, options: RequestOptions): Promise<Response> {
  const { timeoutMs, provider, signal, ...init } = options;

  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (error) {
    throw asProviderError(error, provider, url);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      describeHttpFailure(response.status, body, provider),
      provider,
      response.status,
      hintForStatus(response.status, body, provider),
    );
  }

  return response;
}

function asProviderError(error: unknown, provider: ProviderId, url: string): ProviderError {
  // A user-initiated stop must propagate untouched so the caller can tell it
  // apart from a real failure.
  if (error instanceof DOMException && error.name === 'AbortError') {
    const aborted = new ProviderError('Generation stopped.', provider);
    aborted.name = 'AbortError';
    return aborted;
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new ProviderError(`${label(provider)} did not respond in time.`, provider, undefined, {
      ollama: 'Is `ollama serve` running?',
      llamacpp: 'Is `llama-server` running on the configured port?',
      'openai-compat': 'Is your OpenAI-compatible server reachable?',
    }[provider]);
  }

  const host = safeHost(url);
  return new ProviderError(
    `Could not reach ${label(provider)} at ${host}.`,
    provider,
    undefined,
    connectionHint(provider),
  );
}

function describeHttpFailure(status: number, body: string, provider: ProviderId): string {
  const detail = extractMessage(body);

  if (status === 404) {
    // Ollama's canonical "model not pulled" signal.
    if (/model .* not found|pull the model/i.test(detail)) return detail;
    return `${label(provider)} endpoint not found (404).`;
  }
  if (status === 401 || status === 403) return `${label(provider)} rejected the API key.`;
  if (status === 500 && /out of memory|cuda|vram/i.test(detail))
    return 'The model ran out of memory. Try a smaller quantisation or context window.';

  return detail || `${label(provider)} returned HTTP ${status}.`;
}

function hintForStatus(status: number, body: string, provider: ProviderId): string | undefined {
  const detail = extractMessage(body);
  if (status === 404 && /model/i.test(detail) && provider === 'ollama')
    return 'Pull it first: `ollama pull <model>`';
  if (status === 401 || status === 403) return 'Check the API key in Settings → Backends.';
  return undefined;
}

function connectionHint(provider: ProviderId): string {
  switch (provider) {
    case 'ollama':
      return 'Start it with `ollama serve`, then check the URL in Settings → Backends.';
    case 'llamacpp':
      return 'Start it with `llama-server -m model.gguf --port 8080`.';
    case 'openai-compat':
      return 'Check the base URL in Settings → Backends.';
  }
}

/** Backends bury their message in a few different shapes; try each. */
function extractMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const message =
      parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail ?? '';
    if (typeof message === 'string' && message) return message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body.slice(0, 300);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function label(provider: ProviderId): string {
  return { ollama: 'Ollama', llamacpp: 'llama.cpp', 'openai-compat': 'the model server' }[provider];
}

/**
 * Streams newline-delimited JSON (Ollama's native format).
 *
 * Chunks arrive split at arbitrary byte offsets, so a partial line is carried
 * over to the next chunk rather than being parsed and dropped.
 */
export async function* streamNdjson<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) return;

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
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as T;
        } catch {
          // Malformed line: skip it rather than killing the whole stream.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as T;
      } catch {
        /* ignore trailing garbage */
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Streams Server-Sent Events (the OpenAI wire format). */
export async function* streamSse<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; \r\n\r\n covers proxies that
      // normalise line endings.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as T;
          } catch {
            /* skip malformed frame */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

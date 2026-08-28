/**
 * Ollama backend — the default and best-supported path.
 *
 * Uses Ollama's native `/api/chat` rather than its OpenAI-compatible shim: the
 * native endpoint exposes `thinking` blocks, per-request `num_ctx`, and richer
 * model metadata, all of which Forge surfaces in the UI.
 */
import { createId } from '@/lib/ids';
import { normalizeBaseUrl, providerFetch, streamNdjson, PROBE_TIMEOUT_MS } from './http';
import type {
  ChatRequest,
  FinishReason,
  LlmProvider,
  ProviderHealth,
  ProviderModel,
  StreamEvent,
  ChatMessage,
  ToolSpec,
} from './types';

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    model?: string;
    modified_at?: string;
    size?: number;
    details?: {
      family?: string;
      families?: string[];
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
  model_info?: Record<string, unknown>;
}

interface OllamaChatChunk {
  message?: {
    role?: string;
    content?: string;
    /** Reasoning models emit their scratchpad here, separate from `content`. */
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama';
  readonly baseUrl: string;
  readonly supportsNativeTools = true;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const response = await providerFetch(`${this.baseUrl}/api/version`, {
        provider: this.id,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const { version } = (await response.json()) as { version?: string };

      // Model count makes the health chip informative rather than a bare dot.
      let modelCount: number | undefined;
      try {
        const tags = await providerFetch(`${this.baseUrl}/api/tags`, {
          provider: this.id,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        modelCount = ((await tags.json()) as OllamaTagsResponse).models?.length ?? 0;
      } catch {
        /* version responded, so the server is up; model count is a bonus */
      }

      return {
        id: this.id,
        label: this.label,
        baseUrl: this.baseUrl,
        online: true,
        latencyMs: Date.now() - started,
        version,
        modelCount,
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        baseUrl: this.baseUrl,
        online: false,
        error: error instanceof Error ? error.message : 'Unreachable',
      };
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const response = await providerFetch(`${this.baseUrl}/api/tags`, {
      provider: this.id,
      timeoutMs: 8000,
    });
    const data = (await response.json()) as OllamaTagsResponse;

    return (data.models ?? []).map((m) => {
      const name = m.name ?? m.model ?? '';
      return {
        name,
        displayName: prettifyModelName(name),
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
        sizeBytes: m.size ?? 0,
        modifiedAt: m.modified_at ? Date.parse(m.modified_at) : undefined,
        // `/api/tags` is cheap but shallow; capabilities need `/api/show`, which
        // we only pay for when the user opens a model's detail panel.
        isEmbedding: /embed|bge|gte|minilm|nomic/i.test(name),
      };
    });
  }

  /** Deep metadata for one model. Costs a round trip, so it is opt-in. */
  async describeModel(name: string): Promise<ProviderModel | null> {
    try {
      const response = await providerFetch(`${this.baseUrl}/api/show`, {
        provider: this.id,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        timeoutMs: 8000,
      });
      const data = (await response.json()) as OllamaShowResponse;

      // Context length is published under a family-prefixed key, e.g.
      // "llama.context_length" — find it without hardcoding every family.
      const contextEntry = Object.entries(data.model_info ?? {}).find(([key]) =>
        key.endsWith('.context_length'),
      );

      return {
        name,
        displayName: prettifyModelName(name),
        family: data.details?.family,
        parameterSize: data.details?.parameter_size,
        quantization: data.details?.quantization_level,
        contextLength: typeof contextEntry?.[1] === 'number' ? contextEntry[1] : undefined,
        supportsTools: data.capabilities?.includes('tools') ?? false,
        supportsVision: data.capabilities?.includes('vision') ?? false,
        isEmbedding: data.capabilities?.includes('embedding') ?? false,
      };
    } catch {
      return null;
    }
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, messages, tools, options = {}, signal } = request;

    const response = await providerFetch(`${this.baseUrl}/api/chat`, {
      provider: this.id,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages: messages.map(toOllamaMessage),
        ...(tools?.length ? { tools: tools.map(toOllamaTool) } : {}),
        stream: true,
        options: {
          temperature: options.temperature,
          top_p: options.topP,
          top_k: options.topK,
          repeat_penalty: options.repeatPenalty,
          num_predict: options.maxTokens,
          ...(options.contextWindow ? { num_ctx: options.contextWindow } : {}),
          ...(options.stop?.length ? { stop: options.stop } : {}),
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        },
      }),
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: FinishReason = 'stop';

    for await (const chunk of streamNdjson<OllamaChatChunk>(response)) {
      if (chunk.error) {
        yield { type: 'error', message: chunk.error };
        return;
      }

      const thinking = chunk.message?.thinking;
      if (thinking) yield { type: 'reasoning', delta: thinking };

      const content = chunk.message?.content;
      if (content) yield { type: 'text', delta: content };

      for (const call of chunk.message?.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) continue;
        yield {
          type: 'tool_call',
          // Ollama omits call ids, so we mint one to correlate the result turn.
          call: { id: createId('call'), name, arguments: parseArguments(call.function?.arguments) },
        };
        finishReason = 'tool_calls';
      }

      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count ?? 0;
        completionTokens = chunk.eval_count ?? 0;
        if (chunk.done_reason === 'length') finishReason = 'length';
      }
    }

    yield { type: 'usage', usage: { promptTokens, completionTokens } };
    yield { type: 'done', finishReason };
  }

  /**
   * Embeddings via `/api/embed`, falling back to the pre-0.3 `/api/embeddings`
   * endpoint so older installs keep working.
   */
  async embed(texts: string[], model: string): Promise<number[][]> {
    try {
      const response = await providerFetch(`${this.baseUrl}/api/embed`, {
        provider: this.id,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        timeoutMs: 60_000,
      });
      const data = (await response.json()) as { embeddings?: number[][] };
      if (data.embeddings?.length) return data.embeddings;
    } catch (error) {
      // A 404 means an old Ollama; anything else is a real failure worth raising.
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
    }

    const results: number[][] = [];
    for (const text of texts) {
      const response = await providerFetch(`${this.baseUrl}/api/embeddings`, {
        provider: this.id,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        timeoutMs: 60_000,
      });
      const data = (await response.json()) as { embedding?: number[] };
      results.push(data.embedding ?? []);
    }
    return results;
  }

  /** Streams `ollama pull` progress. Used by the model manager. */
  async *pull(model: string, signal?: AbortSignal) {
    const response = await providerFetch(`${this.baseUrl}/api/pull`, {
      provider: this.id,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });

    for await (const chunk of streamNdjson<{
      status?: string;
      total?: number;
      completed?: number;
      error?: string;
    }>(response)) {
      yield chunk;
    }
  }

  async deleteModel(model: string): Promise<void> {
    await providerFetch(`${this.baseUrl}/api/delete`, {
      provider: this.id,
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      timeoutMs: 15_000,
    });
  }
}

function toOllamaMessage(message: ChatMessage) {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_name: message.name };
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOllamaTool(tool: ToolSpec) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/** Arguments arrive as an object from Ollama but as a JSON string elsewhere. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** "llama3.1:8b-instruct-q4_K_M" → "Llama3.1 8b-instruct-q4_K_M". */
export function prettifyModelName(name: string): string {
  const [base, tag] = name.split(':');
  const pretty = (base ?? name).split('/').pop() ?? name;
  const titled = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  return tag && tag !== 'latest' ? `${titled} ${tag}` : titled;
}

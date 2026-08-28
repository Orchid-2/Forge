/**
 * OpenAI-compatible backend.
 *
 * One implementation covers llama.cpp's `llama-server`, vLLM, LM Studio, TGI,
 * text-generation-webui and any hosted gateway — they all speak
 * `/v1/chat/completions`. The llama.cpp subclass below only differs in how it
 * discovers models and reports health.
 */
import { normalizeBaseUrl, providerFetch, streamSse, PROBE_TIMEOUT_MS } from './http';
import { prettifyModelName } from './ollama';
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  LlmProvider,
  ProviderHealth,
  ProviderId,
  ProviderModel,
  StreamEvent,
  ToolCall,
  ToolSpec,
} from './types';

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** vLLM / llama.cpp expose reasoning models under one of these keys. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseUrl: string;
  readonly supportsNativeTools = true;
  protected readonly apiKey: string;

  constructor(
    baseUrl: string,
    apiKey = '',
    id: ProviderId = 'openai-compat',
    label = 'OpenAI-compatible',
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.id = id;
    this.label = label;
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Many local servers ignore auth entirely; sending a placeholder keeps
      // the ones that *require* the header (but not a valid key) happy.
      Authorization: `Bearer ${this.apiKey || 'forge-local'}`,
    };
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const response = await providerFetch(`${this.baseUrl}/models`, {
        provider: this.id,
        headers: this.headers(),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const data = (await response.json()) as { data?: unknown[] };
      return {
        id: this.id,
        label: this.label,
        baseUrl: this.baseUrl,
        online: true,
        latencyMs: Date.now() - started,
        modelCount: data.data?.length ?? 0,
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
    const response = await providerFetch(`${this.baseUrl}/models`, {
      provider: this.id,
      headers: this.headers(),
      timeoutMs: 8000,
    });
    const data = (await response.json()) as {
      data?: Array<{ id: string; owned_by?: string; max_model_len?: number }>;
    };

    return (data.data ?? []).map((m) => ({
      name: m.id,
      displayName: prettifyModelName(m.id),
      family: m.owned_by,
      // vLLM reports the served context length here; others omit it.
      contextLength: m.max_model_len,
      supportsTools: true,
      isEmbedding: /embed|bge|gte|minilm|nomic/i.test(m.id),
    }));
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, messages, tools, options = {}, signal } = request;

    const response = await providerFetch(`${this.baseUrl}/chat/completions`, {
      provider: this.id,
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model,
        messages: messages.map(toOpenAiMessage),
        ...(tools?.length ? { tools: tools.map(toOpenAiTool), tool_choice: 'auto' } : {}),
        stream: true,
        // Asks compliant servers to send a final usage frame; ignored elsewhere.
        stream_options: { include_usage: true },
        temperature: options.temperature,
        top_p: options.topP,
        max_tokens: options.maxTokens,
        ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        ...(options.repeatPenalty !== undefined ? { repeat_penalty: options.repeatPenalty } : {}),
        ...(options.stop?.length ? { stop: options.stop } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      }),
    });

    /**
     * Tool calls stream in fragments keyed by index: the name arrives in one
     * frame and the JSON arguments accumulate across many. We buffer per index
     * and only emit once the stream tells us the turn is over.
     */
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: FinishReason = 'stop';

    for await (const chunk of streamSse<ChatCompletionChunk>(response)) {
      if (chunk.error?.message) {
        yield { type: 'error', message: chunk.error.message };
        return;
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (reasoning) yield { type: 'reasoning', delta: reasoning };

      const content = choice.delta?.content;
      if (content) yield { type: 'text', delta: content };

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const existing = pending.get(index) ?? { id: '', name: '', args: '' };
        pending.set(index, {
          id: fragment.id || existing.id,
          name: fragment.function?.name || existing.name,
          args: existing.args + (fragment.function?.arguments ?? ''),
        });
      }

      if (choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }

    for (const [index, buffered] of pending) {
      if (!buffered.name) continue;
      yield {
        type: 'tool_call',
        call: {
          id: buffered.id || `call_${index}_${Date.now().toString(36)}`,
          name: buffered.name,
          arguments: safeParseArgs(buffered.args),
        },
      };
      finishReason = 'tool_calls';
    }

    yield { type: 'usage', usage: { promptTokens, completionTokens } };
    yield { type: 'done', finishReason };
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const response = await providerFetch(`${this.baseUrl}/embeddings`, {
      provider: this.id,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: texts }),
      timeoutMs: 60_000,
    });
    const data = (await response.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
    };
    // The spec permits out-of-order results, so sort by index before returning.
    return (data.data ?? [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding);
  }
}

/**
 * llama.cpp's `llama-server`.
 *
 * Chat goes through the OpenAI-compatible surface it exposes, but `/props`
 * gives us the loaded model's real name and context size — information the
 * generic `/v1/models` listing does not carry.
 */
export class LlamaCppProvider extends OpenAiCompatProvider {
  /** llama-server's root, i.e. the base URL without the trailing /v1. */
  private readonly rootUrl: string;

  constructor(baseUrl: string) {
    // llama-server serves OpenAI routes under /v1 while /props sits at the root.
    const root = normalizeBaseUrl(baseUrl).replace(/\/v1$/, '');
    super(`${root}/v1`, '', 'llamacpp', 'llama.cpp');
    this.rootUrl = root;
  }

  override async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const response = await providerFetch(`${this.rootUrl}/props`, {
        provider: this.id,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const data = (await response.json()) as {
        default_generation_settings?: { n_ctx?: number };
        model_path?: string;
      };
      return {
        id: this.id,
        label: this.label,
        baseUrl: this.rootUrl,
        online: true,
        latencyMs: Date.now() - started,
        version: data.default_generation_settings?.n_ctx
          ? `ctx ${data.default_generation_settings.n_ctx}`
          : undefined,
        modelCount: data.model_path ? 1 : 0,
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        baseUrl: this.rootUrl,
        online: false,
        error: error instanceof Error ? error.message : 'Unreachable',
      };
    }
  }

  override async listModels(): Promise<ProviderModel[]> {
    // llama-server hosts exactly one model, so we describe that one richly
    // rather than returning the generic listing.
    try {
      const response = await providerFetch(`${this.rootUrl}/props`, {
        provider: this.id,
        timeoutMs: 5000,
      });
      const data = (await response.json()) as {
        model_path?: string;
        default_generation_settings?: { n_ctx?: number };
      };

      const path = data.model_path ?? '';
      const file = path.split(/[\\/]/).pop() ?? 'loaded model';
      const quantMatch = file.match(/(IQ\d[\w]*|Q\d_[\w]+|F16|BF16|F32)/i);
      const sizeMatch = file.match(/(\d+(?:\.\d+)?)[bB](?![\w])/);

      return [
        {
          // llama-server accepts any model string and routes to what it loaded.
          name: file.replace(/\.gguf$/i, '') || 'default',
          displayName: prettifyModelName(file.replace(/\.gguf$/i, '')),
          quantization: quantMatch?.[1],
          parameterSize: sizeMatch ? `${sizeMatch[1]}B` : undefined,
          contextLength: data.default_generation_settings?.n_ctx,
          supportsTools: true,
        },
      ];
    } catch {
      return super.listModels();
    }
  }
}

function toOpenAiMessage(message: ChatMessage) {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      // The spec wants null, not "", when a turn is purely tool calls.
      content: message.content || null,
      tool_calls: message.toolCalls.map((call: ToolCall) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ToolSpec) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // Small models truncate or double-wrap argument JSON often enough that a
    // repair pass is worth the twenty lines it costs.
    return repairJson(raw);
  }
}

/** Best-effort recovery of a truncated JSON object from a small model. */
function repairJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  if (start === -1) return {};
  const candidate = raw.slice(start);

  // Close any brackets the model left open before giving up on the arguments.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    else if (!inString && char === '{') depth++;
    else if (!inString && char === '}') depth--;
  }

  try {
    return JSON.parse(candidate + (inString ? '"' : '') + '}'.repeat(Math.max(depth, 0)));
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

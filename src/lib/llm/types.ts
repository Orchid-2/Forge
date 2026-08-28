/**
 * Provider-agnostic chat types.
 *
 * Every backend (Ollama, llama.cpp, any OpenAI-compatible server) is adapted to
 * these types at its edge, so the chat pipeline, tool loop and memory system
 * never branch on which backend is in use.
 */
import type { ProviderId } from '@/db/schema';

export type { ProviderId };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool-result turns; ties the result to its request. */
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool as advertised to the model. Mirrors the OpenAI function schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  maxTokens?: number;
  stop?: string[];
  /** Context window to request from the backend, when it accepts one. */
  contextWindow?: number;
  seed?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  options?: SamplingOptions;
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Streaming events.
 *
 * `reasoning` is separate from `text` so thinking-style models can render their
 * chain of thought in a collapsible block instead of polluting the answer.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason }
  | { type: 'error'; message: string };

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error';

export interface ProviderModel {
  /** Identifier passed back to the provider when generating. */
  name: string;
  displayName?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  contextLength?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  isEmbedding?: boolean;
  modifiedAt?: number;
}

export interface ProviderHealth {
  id: ProviderId;
  label: string;
  baseUrl: string;
  online: boolean;
  /** Round-trip latency of the health probe, in ms. */
  latencyMs?: number;
  version?: string;
  modelCount?: number;
  error?: string;
}

/**
 * The contract every backend implements.
 *
 * `chat` returns an async iterable rather than taking callbacks so the caller
 * controls back-pressure and cancellation with plain `for await` + `break`.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly baseUrl: string;

  health(): Promise<ProviderHealth>;
  listModels(): Promise<ProviderModel[]>;
  chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown>;

  /** Not every backend can embed; callers must handle `undefined`. */
  embed?(texts: string[], model: string): Promise<number[][]>;

  /** True when the backend can pass a tool schema to the model natively. */
  readonly supportsNativeTools: boolean;
}

/** Raised for provider failures we can render as a friendly message. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

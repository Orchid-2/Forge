/**
 * Provider registry.
 *
 * Providers are constructed per-request from current settings rather than being
 * long-lived singletons: they are stateless HTTP clients, and rebuilding one is
 * far cheaper than reasoning about cache invalidation when a user edits a base
 * URL in Settings.
 */
import 'server-only';

import { getSettings } from '@/lib/settings';
import { OllamaProvider } from './ollama';
import { LlamaCppProvider, OpenAiCompatProvider } from './openai-compat';
import type { LlmProvider, ProviderHealth, ProviderId, ProviderModel } from './types';

export * from './types';
export { OllamaProvider } from './ollama';
export { LlamaCppProvider, OpenAiCompatProvider } from './openai-compat';
export {
  PromptedToolParser,
  buildToolInstructions,
  likelySupportsNativeTools,
} from './prompted-tools';

export const PROVIDER_IDS: ProviderId[] = ['ollama', 'llamacpp', 'openai-compat'];

export function getProvider(id: ProviderId): LlmProvider {
  const settings = getSettings();
  switch (id) {
    case 'ollama':
      return new OllamaProvider(settings.ollamaBaseUrl);
    case 'llamacpp':
      return new LlamaCppProvider(settings.llamacppBaseUrl);
    case 'openai-compat':
      return new OpenAiCompatProvider(settings.openaiCompatBaseUrl, settings.openaiCompatApiKey);
  }
}

/** Health of every configured backend, probed in parallel. */
export async function probeProviders(): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDER_IDS.map((id) => getProvider(id).health()));
}

export interface DiscoveredModel extends ProviderModel {
  provider: ProviderId;
}

/**
 * Every model across every reachable backend.
 *
 * An offline backend yields an empty list rather than throwing: with three
 * possible backends and typically one running, a failure here is the normal
 * case, not an error.
 */
export async function discoverModels(): Promise<DiscoveredModel[]> {
  const results = await Promise.all(
    PROVIDER_IDS.map(async (id) => {
      try {
        const models = await getProvider(id).listModels();
        return models.map((model) => ({ ...model, provider: id }));
      } catch {
        return [] as DiscoveredModel[];
      }
    }),
  );
  return results.flat();
}

export interface ResolvedModel {
  provider: ProviderId;
  model: string;
}

/**
 * Picks the model for a turn.
 *
 * Precedence runs most-specific to least: an explicit conversation choice beats
 * the project default, which beats the persona's, which beats the app default.
 * Nulls at any level fall through, so a persona can pin a model while another
 * simply inherits.
 */
export function resolveModel(layers: {
  conversation?: { provider?: ProviderId | null; model?: string | null } | null;
  project?: { defaultProvider?: ProviderId | null; defaultModel?: string | null } | null;
  profile?: { provider?: ProviderId | null; model?: string | null } | null;
}): ResolvedModel {
  const settings = getSettings();

  const model =
    layers.conversation?.model ||
    layers.project?.defaultModel ||
    layers.profile?.model ||
    settings.defaultModel;

  const provider =
    layers.conversation?.provider ||
    layers.project?.defaultProvider ||
    layers.profile?.provider ||
    settings.defaultProvider;

  return { provider, model };
}

/**
 * The small model used for background jobs (titles, memory extraction,
 * summaries). Falls back to the chat model so these features work even when the
 * user has never configured a utility model.
 */
export function resolveUtilityModel(fallback?: ResolvedModel): ResolvedModel {
  const settings = getSettings();
  if (settings.utilityModel) {
    return { provider: settings.defaultProvider, model: settings.utilityModel };
  }
  if (fallback?.model) return fallback;
  return { provider: settings.defaultProvider, model: settings.defaultModel };
}

/**
 * Non-streaming completion helper for background jobs.
 *
 * Those jobs want a string, not an event stream, and they must never take the
 * app down — hence the swallowed errors and the timeout.
 */
export async function complete(
  resolved: ResolvedModel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!resolved.model) return '';

  const provider = getProvider(resolved.provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);

  try {
    let output = '';
    for await (const event of provider.chat({
      model: resolved.model,
      messages,
      options: {
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 1024,
      },
      signal: controller.signal,
    })) {
      if (event.type === 'text') output += event.delta;
      if (event.type === 'error') return '';
    }
    return output.trim();
  } catch {
    // Background work is best-effort by design: a summariser failing must never
    // surface as an error in the user's chat.
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rough token estimate for budgeting the context window.
 *
 * Shipping a real tokenizer would mean a per-model vocabulary download, which
 * breaks the offline promise. ~3.6 chars/token is a good average across Llama,
 * Qwen and Mistral vocabularies for English prose and code; we round *up* so
 * the packer errs toward leaving headroom rather than overflowing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

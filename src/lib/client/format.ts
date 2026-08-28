/**
 * Browser-safe formatting helpers.
 *
 * Separate from `lib/utils` only so client components never pull in a module
 * that might grow a server-side import.
 */
export { cn, formatBytes, formatCompact, formatRelative, isMac, timeBucket, truncate } from '@/lib/utils';

/**
 * Rough token count for the composer's live estimate.
 *
 * Mirrors the server's heuristic in `lib/llm/estimateTokens` — a real tokenizer
 * would mean shipping a per-model vocabulary to the browser, which is not worth
 * it for a number displayed to one decimal place of usefulness.
 */
export function estimateTokensClient(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

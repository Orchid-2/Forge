/**
 * Identifier generation.
 *
 * Ids are prefixed and time-sortable: `msg_01k3xr7q2h_a91f`. The prefix makes a
 * stray id in a log immediately legible, and the base36 timestamp means a plain
 * `ORDER BY id` matches creation order — useful when debugging by hand.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export type IdPrefix =
  | 'conv'
  | 'msg'
  | 'mver'
  | 'prof'
  | 'proj'
  | 'mem'
  | 'link'
  | 'model'
  | 'lora'
  | 'mcp'
  | 'tool'
  | 'goal'
  | 'entry'
  | 'act'
  | 'sync'
  | 'call';

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${Date.now().toString(36)}_${randomSuffix()}`;
}

/** Stable content hash, used to skip re-syncing records that haven't changed. */
export function contentHash(input: string): string {
  // FNV-1a: not cryptographic, but fast, dependency-free and collision-safe
  // enough to answer "did this text change?".
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

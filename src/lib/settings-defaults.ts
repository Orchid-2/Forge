/**
 * Application settings: schema, defaults and typing.
 *
 * Lives outside `lib/settings.ts` because the seeder imports it and must stay
 * free of `server-only` database imports.
 *
 * Resolution order is: database value → environment variable → default here.
 * That lets a user configure Forge entirely from the UI, entirely from a
 * `.env.local`, or any mix of the two.
 */
import { z } from 'zod';

export const settingsSchema = z.object({
  /* ── Identity ──────────────────────────────────────────────────────────── */
  /** Injected into every system prompt so the model knows who it is talking to. */
  userName: z.string().default(''),
  userContext: z.string().default(''),

  /* ── Generation defaults ───────────────────────────────────────────────── */
  defaultProvider: z.enum(['ollama', 'llamacpp', 'openai-compat']).default('ollama'),
  defaultModel: z.string().default(''),
  /** Small, fast model used for titles, memory extraction and summaries. */
  utilityModel: z.string().default(''),
  streamResponses: z.boolean().default(true),

  /* ── Backends ──────────────────────────────────────────────────────────── */
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434'),
  llamacppBaseUrl: z.string().default('http://127.0.0.1:8080'),
  openaiCompatBaseUrl: z.string().default('http://127.0.0.1:8000/v1'),
  openaiCompatApiKey: z.string().default(''),

  /* ── Memory ────────────────────────────────────────────────────────────── */
  memoryEnabled: z.boolean().default(true),
  /** Mine finished turns for durable facts in the background. */
  memoryAutoExtract: z.boolean().default(true),
  embeddingModel: z.string().default('nomic-embed-text'),
  /** How many memories to retrieve before filtering by score. */
  memoryTopK: z.number().int().min(1).max(50).default(12),
  /** Similarity floor; below this a memory is noise rather than context. */
  memoryMinScore: z.number().min(0).max(1).default(0.28),
  /** Hard cap on memories injected into a prompt, to protect the context window. */
  memoryMaxInjected: z.number().int().min(0).max(30).default(8),
  /** Blend of vector vs keyword score in hybrid retrieval. 1 = pure vector. */
  memoryVectorWeight: z.number().min(0).max(1).default(0.7),

  /* ── Conversation hygiene ──────────────────────────────────────────────── */
  autoTitle: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  /** Compress older turns once a conversation passes this many messages. */
  summarizeAfterMessages: z.number().int().min(6).max(200).default(30),
  /** Turns kept verbatim after the summary boundary. */
  summarizeKeepRecent: z.number().int().min(2).max(50).default(12),

  /* ── Tools ─────────────────────────────────────────────────────────────── */
  toolsEnabled: z.boolean().default(true),
  /** Safety rail against a model looping on tool calls forever. */
  maxToolIterations: z.number().int().min(1).max(10).default(5),
  searchProvider: z.enum(['duckduckgo', 'searxng', 'tavily', 'brave']).default('duckduckgo'),
  searxngBaseUrl: z.string().default(''),
  tavilyApiKey: z.string().default(''),
  braveApiKey: z.string().default(''),
  searchMaxResults: z.number().int().min(1).max(20).default(5),

  /* ── Hugging Face ──────────────────────────────────────────────────────── */
  hfToken: z.string().default(''),
  /** Private dataset repo backing up conversations and memories. */
  hfBackupRepo: z.string().default(''),
  hfAutoSync: z.boolean().default(false),

  /* ── Obsidian ──────────────────────────────────────────────────────────── */
  obsidianEnabled: z.boolean().default(false),
  obsidianVaultPath: z.string().default(''),
  /** Folder inside the vault that Forge writes to. Existing structure untouched. */
  obsidianFolder: z.string().default('Forge'),
  obsidianAutoSync: z.boolean().default(false),
  /** Write `[[wikilinks]]` between notes rather than plain text references. */
  obsidianWikilinks: z.boolean().default(true),

  /* ── Appearance ────────────────────────────────────────────────────────── */
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  /** Vertical rhythm of the chat transcript. */
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  fontScale: z.number().min(0.85).max(1.3).default(1),
  reduceMotion: z.boolean().default(false),
  /** Enter sends; Shift+Enter newlines. Flip for the opposite. */
  sendOnEnter: z.boolean().default(true),
  showTokenStats: z.boolean().default(true),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Environment fallbacks. Only consulted when a key has never been written from
 * the UI, so a `.env.local` seeds the app without ever overriding a later
 * in-app change.
 */
export const ENV_FALLBACKS: Partial<Record<SettingKey, string | undefined>> = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  llamacppBaseUrl: process.env.LLAMACPP_BASE_URL,
  openaiCompatBaseUrl: process.env.OPENAI_COMPAT_BASE_URL,
  openaiCompatApiKey: process.env.OPENAI_COMPAT_API_KEY,
  embeddingModel: process.env.FORGE_EMBEDDING_MODEL,
  hfToken: process.env.HF_TOKEN,
  hfBackupRepo: process.env.HF_BACKUP_REPO,
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH,
  searchProvider: process.env.FORGE_SEARCH_PROVIDER,
  searxngBaseUrl: process.env.SEARXNG_BASE_URL,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  braveApiKey: process.env.BRAVE_API_KEY,
};

/**
 * Keys never sent to the browser in full. The settings API returns a masked
 * placeholder for these and treats that placeholder as "leave unchanged" on
 * write, so a token can never be clobbered by a form round-trip.
 */
export const SECRET_KEYS = ['hfToken', 'openaiCompatApiKey', 'tavilyApiKey', 'braveApiKey'] as const;
export const SECRET_MASK = '••••••••';

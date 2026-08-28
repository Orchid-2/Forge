/**
 * Forge database schema (SQLite via Drizzle).
 *
 * Design notes
 * ------------
 * - Everything is single-user; there is no `users` table. The `settings` table
 *   holds the one "profile of the human" record plus all app configuration.
 * - Timestamps are stored as INTEGER epoch-milliseconds. SQLite has no native
 *   date type and epoch-ms sorts, ranges and diffs correctly without parsing.
 * - JSON-shaped columns are stored as TEXT and typed with `$type<T>()`, so the
 *   TypeScript side stays honest even though SQLite sees a string.
 * - Counters like `conversations.messageCount` are denormalised on purpose: the
 *   dashboard and sidebar read them on every render and a COUNT(*) per row does
 *   not scale past a few thousand conversations.
 */
import { sql, relations } from 'drizzle-orm';
import { sqliteTable, text, integer, real, blob, index } from 'drizzle-orm/sqlite-core';

/** Epoch-ms column with a sensible default. */
const timestamp = (name: string) =>
  integer(name, { mode: 'number' })
    .notNull()
    .$defaultFn(() => Date.now());

/** SQLite has no boolean; Drizzle maps 0/1 for us. */
const bool = (name: string, defaultValue = false) =>
  integer(name, { mode: 'boolean' }).notNull().default(defaultValue);

/* ────────────────────────────────────────────────────────────────────────────
 * Settings — key/value store for everything configurable at runtime.
 * Values written here take precedence over environment variables.
 * ──────────────────────────────────────────────────────────────────────────── */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded. Read through `getSetting()` which parses and validates. */
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at'),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Profiles — the personas. A profile is a complete generation configuration:
 * who the model is, which model, how hot, and which tools it may reach for.
 * ──────────────────────────────────────────────────────────────────────────── */
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** Single emoji shown in the switcher — cheap, expressive, no asset pipeline. */
    icon: text('icon').notNull().default('◈'),
    /** Tailwind-compatible HSL triplet, e.g. "24 95% 58%". Tints the profile chip. */
    accent: text('accent').notNull().default('24 95% 58%'),

    systemPrompt: text('system_prompt').notNull().default(''),

    /** Null means "inherit the app-level default model". */
    provider: text('provider').$type<ProviderId>(),
    model: text('model'),

    temperature: real('temperature').notNull().default(0.8),
    topP: real('top_p').notNull().default(0.95),
    topK: integer('top_k').notNull().default(40),
    repeatPenalty: real('repeat_penalty').notNull().default(1.1),
    maxTokens: integer('max_tokens').notNull().default(2048),
    /** Context window to pack; null = ask the provider what the model supports. */
    contextWindow: integer('context_window'),
    /** Extra stop sequences, JSON array. */
    stopSequences: text('stop_sequences', { mode: 'json' }).$type<string[]>().default([]),

    /** Tool ids this persona is allowed to call. Empty array = no tools. */
    enabledTools: text('enabled_tools', { mode: 'json' }).$type<string[]>().default([]),

    /** Whether relevant long-term memories are injected into the prompt. */
    memoryRead: bool('memory_read', true),
    /** Whether new memories are extracted from conversations using this profile. */
    memoryWrite: bool('memory_write', true),

    isDefault: bool('is_default'),
    archived: bool('archived'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('profiles_sort_idx').on(t.sortOrder), index('profiles_archived_idx').on(t.archived)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Projects — a workspace grouping conversations, with its own instructions,
 * default model and a memory scope shared by every chat inside it.
 * ──────────────────────────────────────────────────────────────────────────── */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon').notNull().default('▲'),
    accent: text('accent').notNull().default('190 90% 50%'),

    /** Layered *above* the profile prompt — project context, not persona. */
    systemPrompt: text('system_prompt').notNull().default(''),

    defaultProfileId: text('default_profile_id').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    defaultProvider: text('default_provider').$type<ProviderId>(),
    defaultModel: text('default_model'),

    /** Memories created in this project default to project scope. */
    memoryScoped: bool('memory_scoped', true),

    pinned: bool('pinned'),
    archived: bool('archived'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('projects_archived_idx').on(t.archived), index('projects_pinned_idx').on(t.pinned)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Conversations
 * ──────────────────────────────────────────────────────────────────────────── */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('New chat'),
    /** Set once the title has been auto-generated so we stop regenerating it. */
    titleGenerated: bool('title_generated'),

    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),

    provider: text('provider').$type<ProviderId>(),
    model: text('model'),
    /** Per-conversation override; falls back to project + profile prompts. */
    systemPrompt: text('system_prompt'),

    /**
     * Rolling summary of turns older than `summarizedUntil`, used to keep long
     * conversations inside the context window without losing the thread.
     */
    summary: text('summary'),
    summarizedUntil: integer('summarized_until').notNull().default(0),

    messageCount: integer('message_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),

    pinned: bool('pinned'),
    archived: bool('archived'),

    lastMessageAt: timestamp('last_message_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [
    index('conversations_project_idx').on(t.projectId),
    index('conversations_updated_idx').on(t.lastMessageAt),
    index('conversations_archived_idx').on(t.archived),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Messages
 *
 * Ordering uses an explicit integer `seq` rather than createdAt: two messages
 * can land in the same millisecond, and regeneration must not reshuffle a
 * transcript.
 * ──────────────────────────────────────────────────────────────────────────── */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    seq: integer('seq').notNull(),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull().default(''),

    /** Chain-of-thought from reasoning models, kept separate from the answer. */
    reasoning: text('reasoning'),

    /** Assistant tool-call requests, and the tool result linkage. */
    toolCalls: text('tool_calls', { mode: 'json' }).$type<StoredToolCall[]>(),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),

    /** Memory ids injected into the prompt for this turn — shown as citations. */
    citedMemoryIds: text('cited_memory_ids', { mode: 'json' }).$type<string[]>(),

    provider: text('provider').$type<ProviderId>(),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),

    pinned: bool('pinned'),
    /** Populated when generation failed, so the turn renders as a retryable error. */
    error: text('error'),

    /** How many alternates exist in `messageVersions`, and which one is showing. */
    versionCount: integer('version_count').notNull().default(1),
    activeVersion: integer('active_version').notNull().default(0),

    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.seq),
    index('messages_pinned_idx').on(t.pinned),
    index('messages_created_idx').on(t.createdAt),
  ],
);

/**
 * Alternate takes on a message, produced by edit + regenerate. The message row
 * always holds the *active* text; this table holds the others, so the UI can
 * offer a "‹ 2 / 3 ›" pager without branching the whole conversation tree.
 */
export const messageVersions = sqliteTable(
  'message_versions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    reasoning: text('reasoning'),
    toolCalls: text('tool_calls', { mode: 'json' }).$type<StoredToolCall[]>(),
    model: text('model'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('message_versions_message_idx').on(t.messageId, t.version)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Memories — the long-term store. Embeddings are raw Float32 bytes in a BLOB;
 * see `lib/memory/vector-store.ts` for why that beats a separate vector DB at
 * personal-knowledge-base scale.
 * ──────────────────────────────────────────────────────────────────────────── */
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    /** One self-contained statement. Retrieval quality lives or dies on this. */
    content: text('content').notNull(),
    /** Short label for list views; generated alongside the content. */
    title: text('title'),

    kind: text('kind').$type<MemoryKind>().notNull().default('fact'),
    /** 0..1 — drives ranking and what survives pruning. */
    importance: real('importance').notNull().default(0.5),
    /** 0..1 — how sure the extractor was. Manual entries are always 1. */
    confidence: real('confidence').notNull().default(0.8),

    source: text('source').$type<MemorySource>().notNull().default('auto'),
    sourceConversationId: text('source_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    sourceMessageId: text('source_message_id'),

    /** Null scope = global. Otherwise the memory only surfaces in that context. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),

    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),

    /** Pinned memories are always injected, regardless of similarity score. */
    pinned: bool('pinned'),
    archived: bool('archived'),

    /** Usage feeds the ranker: memories that keep proving useful rank higher. */
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: integer('last_accessed_at'),

    /** Float32Array bytes. Null until the embedder has run. */
    embedding: blob('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingDim: integer('embedding_dim'),

    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [
    index('memories_project_idx').on(t.projectId),
    index('memories_kind_idx').on(t.kind),
    index('memories_archived_idx').on(t.archived),
    index('memories_pinned_idx').on(t.pinned),
    index('memories_created_idx').on(t.createdAt),
  ],
);

/**
 * Typed edges between memories. Powers the "related" rail in the memory view and
 * exports as real `[[wikilinks]]` when syncing to Obsidian.
 */
export const memoryLinks = sqliteTable(
  'memory_links',
  {
    id: text('id').primaryKey(),
    fromId: text('from_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull().default('related'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('memory_links_from_idx').on(t.fromId), index('memory_links_to_idx').on(t.toId)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Models — the local model registry, including in-flight Hugging Face pulls.
 * ──────────────────────────────────────────────────────────────────────────── */
export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    /** The identifier passed to the backend, e.g. "llama3.1:8b-instruct-q4_K_M". */
    name: text('name').notNull(),
    displayName: text('display_name'),
    provider: text('provider').$type<ProviderId>().notNull(),

    family: text('family'),
    parameterSize: text('parameter_size'),
    quantization: text('quantization'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    contextLength: integer('context_length'),

    /** Where it came from: discovered on a running backend, or pulled by us. */
    source: text('source').$type<ModelSource>().notNull().default('ollama'),
    hfRepoId: text('hf_repo_id'),
    hfFilename: text('hf_filename'),
    localPath: text('local_path'),

    status: text('status').$type<ModelStatus>().notNull().default('ready'),
    downloadedBytes: integer('downloaded_bytes').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    statusMessage: text('status_message'),

    capabilities: text('capabilities', { mode: 'json' })
      .$type<ModelCapabilities>()
      .default({ tools: false, vision: false, embedding: false, reasoning: false }),

    favorite: bool('favorite'),
    lastUsedAt: integer('last_used_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('models_provider_idx').on(t.provider), index('models_status_idx').on(t.status)],
);

/** LoRA / adapter registry, attachable to a base model at load time. */
export const adapters = sqliteTable(
  'adapters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    baseModelId: text('base_model_id').references(() => models.id, { onDelete: 'cascade' }),
    hfRepoId: text('hf_repo_id'),
    hfFilename: text('hf_filename'),
    localPath: text('local_path'),
    /** Adapter strength when applied. */
    scale: real('scale').notNull().default(1.0),
    sizeBytes: integer('size_bytes').notNull().default(0),
    status: text('status').$type<ModelStatus>().notNull().default('ready'),
    downloadedBytes: integer('downloaded_bytes').notNull().default(0),
    totalBytes: integer('total_bytes').notNull().default(0),
    statusMessage: text('status_message'),
    active: bool('active'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('adapters_base_idx').on(t.baseModelId)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * MCP servers and custom tools
 * ──────────────────────────────────────────────────────────────────────────── */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  transport: text('transport').$type<McpTransport>().notNull().default('stdio'),

  /** stdio transport */
  command: text('command'),
  args: text('args', { mode: 'json' }).$type<string[]>().default([]),
  env: text('env', { mode: 'json' }).$type<Record<string, string>>().default({}),

  /** http / sse transport */
  url: text('url'),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().default({}),

  enabled: bool('enabled', true),
  status: text('status').$type<McpStatus>().notNull().default('disconnected'),
  lastError: text('last_error'),
  /** Cached tool list from the last successful handshake. */
  discoveredTools: text('discovered_tools', { mode: 'json' }).$type<McpToolSummary[]>().default([]),
  lastConnectedAt: integer('last_connected_at'),

  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

/** User-defined HTTP tools — the "add custom tools later" escape hatch. */
export const customTools = sqliteTable('custom_tools', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** JSON Schema for the arguments object. */
  parameters: text('parameters', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  method: text('method').notNull().default('POST'),
  url: text('url').notNull().default(''),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().default({}),
  /** Body template; `{{arg}}` placeholders are filled from the call arguments. */
  bodyTemplate: text('body_template'),
  enabled: bool('enabled', true),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Personal progress tracking — the customisable half of the dashboard.
 * ──────────────────────────────────────────────────────────────────────────── */
export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    icon: text('icon').notNull().default('◎'),
    accent: text('accent').notNull().default('142 70% 45%'),
    kind: text('kind').$type<GoalKind>().notNull().default('counter'),
    unit: text('unit').notNull().default(''),
    target: real('target').notNull().default(0),
    /** Cached roll-up of `goalEntries`, recomputed on write. */
    current: real('current').notNull().default(0),
    /** For streak goals: how many consecutive days have entries. */
    streak: integer('streak').notNull().default(0),
    archived: bool('archived'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('goals_archived_idx').on(t.archived)],
);

export const goalEntries = sqliteTable(
  'goal_entries',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    value: real('value').notNull().default(1),
    note: text('note'),
    /** YYYY-MM-DD in local time, so "one per day" logic is a string compare. */
    day: text('day').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('goal_entries_goal_idx').on(t.goalId, t.day)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Sync bookkeeping for the Hugging Face and Obsidian integrations.
 * ──────────────────────────────────────────────────────────────────────────── */
export const syncState = sqliteTable('sync_state', {
  id: text('id').primaryKey(),
  target: text('target').$type<SyncTarget>().notNull(),
  /** Entity id when tracking per-conversation sync, or '*' for whole-store sync. */
  entityId: text('entity_id').notNull().default('*'),
  /** Content hash of what was last pushed — lets us skip unchanged records. */
  contentHash: text('content_hash'),
  remoteRef: text('remote_ref'),
  status: text('status').$type<SyncStatus>().notNull().default('idle'),
  error: text('error'),
  syncedAt: integer('synced_at'),
  updatedAt: timestamp('updated_at'),
});

/** Append-only log powering the dashboard's "recent activity" rail. */
export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    type: text('type').$type<ActivityType>().notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    entityId: text('entity_id'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('activity_created_idx').on(t.createdAt)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Relations (for Drizzle's relational query API)
 * ──────────────────────────────────────────────────────────────────────────── */
export const conversationRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, { fields: [conversations.projectId], references: [projects.id] }),
  profile: one(profiles, { fields: [conversations.profileId], references: [profiles.id] }),
  messages: many(messages),
}));

export const messageRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  versions: many(messageVersions),
}));

export const messageVersionRelations = relations(messageVersions, ({ one }) => ({
  message: one(messages, { fields: [messageVersions.messageId], references: [messages.id] }),
}));

export const projectRelations = relations(projects, ({ many, one }) => ({
  conversations: many(conversations),
  memories: many(memories),
  defaultProfile: one(profiles, {
    fields: [projects.defaultProfileId],
    references: [profiles.id],
  }),
}));

export const memoryRelations = relations(memories, ({ one }) => ({
  project: one(projects, { fields: [memories.projectId], references: [projects.id] }),
  sourceConversation: one(conversations, {
    fields: [memories.sourceConversationId],
    references: [conversations.id],
  }),
}));

export const goalRelations = relations(goals, ({ many }) => ({
  entries: many(goalEntries),
}));

export const goalEntryRelations = relations(goalEntries, ({ one }) => ({
  goal: one(goals, { fields: [goalEntries.goalId], references: [goals.id] }),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Column union types. Kept here so the schema is the single source of truth.
 * ──────────────────────────────────────────────────────────────────────────── */
export type ProviderId = 'ollama' | 'llamacpp' | 'openai-compat';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'event'
  | 'entity'
  | 'instruction'
  | 'insight'
  | 'summary';
export type MemorySource = 'auto' | 'manual' | 'import' | 'summary';
export type ModelSource = 'ollama' | 'llamacpp' | 'huggingface' | 'openai-compat';
export type ModelStatus = 'ready' | 'downloading' | 'queued' | 'error' | 'missing';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpStatus = 'connected' | 'disconnected' | 'error' | 'connecting';
export type GoalKind = 'counter' | 'streak' | 'target';
export type SyncTarget = 'huggingface' | 'obsidian';
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';
export type ActivityType =
  | 'conversation.created'
  | 'memory.created'
  | 'memory.pruned'
  | 'model.downloaded'
  | 'project.created'
  | 'sync.completed'
  | 'goal.logged';

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  embedding: boolean;
  reasoning: boolean;
}

export interface StoredToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Filled in once the tool has run, so a reload replays the same transcript. */
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/* Row types — inferred, never hand-written. */
export type Setting = typeof settings.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageVersion = typeof messageVersions.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryLink = typeof memoryLinks.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;
export type Adapter = typeof adapters.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type CustomTool = typeof customTools.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type GoalEntry = typeof goalEntries.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;

/** Re-exported so callers can `sql` without a second drizzle import. */
export { sql };

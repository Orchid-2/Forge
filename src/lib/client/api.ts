/**
 * Browser-side API client.
 *
 * A thin typed wrapper over `fetch` that unwraps the `{ error, hint }` envelope
 * the routes use, so callers can `try/catch` a real Error instead of inspecting
 * response shapes at every call site.
 */
import type {
  Conversation,
  CustomTool,
  Goal,
  GoalEntry,
  McpServer,
  Memory,
  Message,
  MessageVersion,
  ModelRow,
  Adapter,
  Profile,
  Project,
} from '@/db/schema';
import type { Settings } from '@/lib/settings-defaults';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body from an API route means something crashed upstream of
      // our handler; surface the raw text rather than a parse error.
      if (!response.ok) throw new ApiClientError(text.slice(0, 200), response.status);
    }
  }

  if (!response.ok) {
    const error = payload as { error?: string; hint?: string } | null;
    throw new ApiClientError(
      error?.error ?? `Request failed (${response.status})`,
      response.status,
      error?.hint,
    );
  }

  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** Builds a query string, omitting empty values. */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export interface ScoredMemoryRow extends Memory {
  score?: number;
  reason?: string;
}

export interface ProjectWithCounts extends Project {
  conversationCount: number;
  memoryCount: number;
}

export interface GoalWithEntries extends Goal {
  entries: GoalEntry[];
}

export interface ProviderHealthRow {
  id: string;
  label: string;
  baseUrl: string;
  online: boolean;
  latencyMs?: number;
  version?: string;
  modelCount?: number;
  error?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  requiresNetwork: boolean;
  parameters: Record<string, unknown>;
}

export interface StatsResponse {
  totals: {
    conversations: number;
    messages: number;
    memories: number;
    projects: number;
    tokens: number;
    pinnedMemories: number;
    models: number;
  };
  series: Array<{
    day: string;
    messages: number;
    tokens: number;
    memories: number;
    memoryTotal: number;
  }>;
  memoryKinds: Array<{ kind: string; count: number }>;
  topModels: Array<{ model: string | null; provider: string | null; count: number; tokens: number }>;
  recentActivity: Array<{
    id: string;
    type: string;
    title: string;
    detail: string | null;
    entityId: string | null;
    createdAt: number;
  }>;
  recentConversations: Array<{
    id: string;
    title: string;
    messageCount: number;
    lastMessageAt: number;
    projectId: string | null;
  }>;
  goals: Goal[];
  derived: { activeDays: number; streak: number; avgMessagesPerDay: number; windowDays: number };
}

export interface SearchResponse {
  conversations: Array<{
    id: string;
    title: string;
    lastMessageAt: number;
    projectId: string | null;
  }>;
  messages: Array<{
    id: string;
    conversationId: string;
    content: string;
    role: string;
    createdAt: number;
    conversationTitle?: string;
  }>;
  memories: Array<{
    id: string;
    title: string | null;
    content: string;
    kind: string;
    score: number;
  }>;
}

export interface HfModelSummaryRow {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  updatedAt: string;
  tags: string[];
  pipelineTag?: string;
  gated: boolean;
  isAdapter: boolean;
}

export interface HfFileRow {
  path: string;
  size: number;
  quantization?: string;
  isShardIndex?: boolean;
}

export interface VaultStatusRow {
  configured: boolean;
  valid: boolean;
  path: string;
  folder: string;
  error?: string;
  noteCount?: number;
}

export interface HubStatusRow {
  configured: boolean;
  valid: boolean;
  repo: string;
  user?: string;
  error?: string;
  lastSyncAt?: number;
  syncedConversations?: number;
}

export const api = {
  /* ── Conversations ─────────────────────────────────────────────────────── */
  listConversations: (params: { projectId?: string; archived?: boolean; q?: string } = {}) =>
    get<{ conversations: Conversation[] }>(`/api/conversations${qs(params)}`),

  getConversation: (id: string) =>
    get<{ conversation: Conversation; messages: Message[]; versions: MessageVersion[] }>(
      `/api/conversations/${id}`,
    ),

  createConversation: (body: {
    title?: string;
    projectId?: string | null;
    profileId?: string | null;
    provider?: string | null;
    model?: string | null;
  }) => post<{ conversation: Conversation }>('/api/conversations', body),

  updateConversation: (id: string, body: Partial<Conversation>) =>
    patch<{ conversation: Conversation }>(`/api/conversations/${id}`, body),

  deleteConversation: (id: string) => del<{ deleted: string }>(`/api/conversations/${id}`),

  /* ── Messages ──────────────────────────────────────────────────────────── */
  updateMessage: (id: string, body: { content?: string; pinned?: boolean; activeVersion?: number }) =>
    patch<{ message: Message }>(`/api/messages/${id}`, body),

  deleteMessage: (id: string, cascade = false) =>
    del<{ deleted: string; messages: Message[] }>(`/api/messages/${id}${cascade ? '?cascade' : ''}`),

  /* ── Profiles ──────────────────────────────────────────────────────────── */
  listProfiles: () => get<{ profiles: Profile[] }>('/api/profiles'),
  createProfile: (body: Partial<Profile> & { name: string }) =>
    post<{ profile: Profile }>('/api/profiles', body),
  updateProfile: (id: string, body: Partial<Profile>) =>
    patch<{ profile: Profile }>(`/api/profiles/${id}`, body),
  deleteProfile: (id: string) => del<{ deleted: string }>(`/api/profiles/${id}`),

  /* ── Projects ──────────────────────────────────────────────────────────── */
  listProjects: () => get<{ projects: ProjectWithCounts[] }>('/api/projects'),
  getProject: (id: string) =>
    get<{ project: Project; conversations: Conversation[]; memories: Memory[] }>(
      `/api/projects/${id}`,
    ),
  createProject: (body: Partial<Project> & { name: string }) =>
    post<{ project: Project }>('/api/projects', body),
  updateProject: (id: string, body: Partial<Project>) =>
    patch<{ project: Project }>(`/api/projects/${id}`, body),
  deleteProject: (id: string, purge = false) =>
    del<{ deleted: string }>(`/api/projects/${id}${purge ? '?purge' : ''}`),

  /* ── Memories ──────────────────────────────────────────────────────────── */
  listMemories: (
    params: {
      q?: string;
      projectId?: string;
      kind?: string;
      pinned?: boolean;
      archived?: boolean;
      limit?: number;
    } = {},
  ) => get<{ memories: ScoredMemoryRow[] }>(`/api/memories${qs(params)}`),

  createMemory: (body: {
    content: string;
    title?: string;
    kind?: string;
    importance?: number;
    projectId?: string | null;
    tags?: string[];
    pinned?: boolean;
  }) => post<{ memory: Memory; deduplicated: boolean }>('/api/memories', body),

  updateMemory: (id: string, body: Partial<Memory>) =>
    patch<{ memory: Memory }>(`/api/memories/${id}`, body),
  deleteMemory: (id: string) => del<{ deleted: string }>(`/api/memories/${id}`),
  reembedMemories: () => post<{ updated: number }>('/api/memory/reembed'),

  /* ── Models ────────────────────────────────────────────────────────────── */
  listModels: (refresh = false) =>
    get<{ models: ModelRow[]; adapters: Adapter[] }>(`/api/models${refresh ? '?refresh' : ''}`),
  refreshModels: () => post<{ discovered: number; missing: number; models: ModelRow[] }>('/api/models'),
  getModel: (id: string) => get<{ model: ModelRow }>(`/api/models/${id}`),
  favoriteModel: (id: string, favorite: boolean) =>
    patch<{ id: string; favorite: boolean }>(`/api/models/${id}`, { favorite }),
  deleteModel: (id: string) => del<{ deleted: string }>(`/api/models/${id}`),

  searchHfModels: (params: { q: string; library?: string; adapters?: boolean; limit?: number }) =>
    get<{ models: HfModelSummaryRow[] }>(`/api/models/hf${qs(params)}`),
  listHfFiles: (repo: string) => get<{ repo: string; files: HfFileRow[] }>(`/api/models/hf${qs({ repo })}`),
  downloadHfModel: (body: {
    repoId: string;
    filename: string;
    asAdapter?: boolean;
    displayName?: string;
  }) => post<{ id: string; started: boolean }>('/api/models/hf', body),

  /* ── Settings, providers, tools ────────────────────────────────────────── */
  getSettings: () => get<{ settings: Settings }>('/api/settings'),
  updateSettings: (body: Partial<Settings>) => patch<{ settings: Settings }>('/api/settings', body),
  getProviders: () => get<{ providers: ProviderHealthRow[] }>('/api/providers'),
  listTools: () => get<{ tools: ToolInfo[] }>('/api/tools'),

  /* ── MCP ───────────────────────────────────────────────────────────────── */
  listMcpServers: () => get<{ servers: McpServer[] }>('/api/mcp'),
  createMcpServer: (body: Partial<McpServer> & { name: string }) =>
    post<{ server: McpServer; connection: { ok: boolean; error?: string } }>('/api/mcp', body),
  updateMcpServer: (id: string, body: Partial<McpServer>) =>
    patch<{ server: McpServer }>(`/api/mcp/${id}`, body),
  refreshMcpServer: (id: string) =>
    post<{ server: McpServer; connection: { ok: boolean; error?: string } }>(`/api/mcp/${id}`),
  deleteMcpServer: (id: string) => del<{ deleted: string }>(`/api/mcp/${id}`),

  /* ── Dashboard ─────────────────────────────────────────────────────────── */
  getStats: (days = 30) => get<StatsResponse>(`/api/stats${qs({ days })}`),
  search: (q: string) => get<SearchResponse>(`/api/search${qs({ q })}`),

  listGoals: () => get<{ goals: GoalWithEntries[] }>('/api/goals'),
  createGoal: (body: { title: string; kind?: string; unit?: string; target?: number; icon?: string; accent?: string }) =>
    post<{ goal: GoalWithEntries }>('/api/goals', body),
  logGoal: (id: string, value = 1, note?: string) =>
    post<{ goal: Goal }>(`/api/goals/${id}`, { value, note }),
  updateGoal: (id: string, body: Partial<Goal>) => patch<{ goal: Goal }>(`/api/goals/${id}`, body),
  deleteGoal: (id: string) => del<{ deleted: string }>(`/api/goals/${id}`),

  /* ── Integrations ──────────────────────────────────────────────────────── */
  getVaultStatus: () => get<{ vault: VaultStatusRow }>('/api/obsidian'),
  syncVault: (body: { conversationId?: string; memoryId?: string } = {}) =>
    post<{ summary?: { conversations: number; memories: number; skipped: number; errors: string[] }; written?: string | null }>(
      '/api/obsidian',
      body,
    ),

  getHubStatus: () => get<{ hub: HubStatusRow }>('/api/hf'),
  syncHub: (action: 'push' | 'pull' = 'push', force = false) =>
    post<{
      action: string;
      summary: { conversations: number; memories: number; skipped?: number; errors: string[] };
    }>('/api/hf', { action, force }),
};

export type { CustomTool };

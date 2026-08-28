'use client';

/**
 * Global application state: settings, personas, projects, models and UI chrome.
 *
 * Conversation state lives in its own store — it churns on every streamed token
 * and would otherwise re-render the sidebar and model switcher hundreds of
 * times per reply.
 */
import { create } from 'zustand';

import type { Adapter, ModelRow, Profile } from '@/db/schema';
import { api, type ProjectWithCounts, type ProviderHealthRow, type ToolInfo } from '@/lib/client/api';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings-defaults';

interface AppState {
  settings: Settings;
  profiles: Profile[];
  projects: ProjectWithCounts[];
  models: ModelRow[];
  adapters: Adapter[];
  providers: ProviderHealthRow[];
  tools: ToolInfo[];

  /** False until the first load resolves, so the shell can hold its skeleton. */
  ready: boolean;
  /** Persisted UI chrome. */
  sidebarCollapsed: boolean;
  commandOpen: boolean;

  loadAll: () => Promise<void>;
  refreshModels: (probeBackends?: boolean) => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshProfiles: () => Promise<void>;

  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setCommandOpen: (open: boolean) => void;

  /** Convenience selectors used all over the UI. */
  defaultProfile: () => Profile | undefined;
  findProfile: (id: string | null | undefined) => Profile | undefined;
  findProject: (id: string | null | undefined) => ProjectWithCounts | undefined;
  findModel: (name: string | null | undefined) => ModelRow | undefined;
}

const SIDEBAR_KEY = 'forge:sidebar-collapsed';

function readSidebarPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    // Private browsing or blocked storage — the default is fine.
    return false;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  profiles: [],
  projects: [],
  models: [],
  adapters: [],
  providers: [],
  tools: [],
  ready: false,
  sidebarCollapsed: readSidebarPreference(),
  commandOpen: false,

  async loadAll() {
    // Everything in parallel; a failing backend probe must not block personas
    // or settings from loading, so each result is handled independently.
    const [settings, profiles, projects, models, tools] = await Promise.allSettled([
      api.getSettings(),
      api.listProfiles(),
      api.listProjects(),
      api.listModels(),
      api.listTools(),
    ]);

    set({
      settings: settings.status === 'fulfilled' ? settings.value.settings : DEFAULT_SETTINGS,
      profiles: profiles.status === 'fulfilled' ? profiles.value.profiles : [],
      projects: projects.status === 'fulfilled' ? projects.value.projects : [],
      models: models.status === 'fulfilled' ? models.value.models : [],
      adapters: models.status === 'fulfilled' ? models.value.adapters : [],
      tools: tools.status === 'fulfilled' ? tools.value.tools : [],
      ready: true,
    });

    // Probing backends means real network timeouts, so it runs after the shell
    // has already rendered rather than gating it.
    void get().refreshProviders();
  },

  async refreshModels(probeBackends = false) {
    try {
      const { models, adapters } = await api.listModels(probeBackends);
      set({ models, adapters });
    } catch {
      /* keep the previous list rather than blanking the switcher */
    }
  },

  async refreshProviders() {
    try {
      const { providers } = await api.getProviders();
      set({ providers });
    } catch {
      set({ providers: [] });
    }
  },

  async refreshProjects() {
    try {
      const { projects } = await api.listProjects();
      set({ projects });
    } catch {
      /* ignore */
    }
  },

  async refreshProfiles() {
    try {
      const { profiles } = await api.listProfiles();
      set({ profiles });
    } catch {
      /* ignore */
    }
  },

  async saveSettings(patch) {
    // Optimistic: settings changes should feel instant, and the server echo
    // corrects anything it normalised.
    set({ settings: { ...get().settings, ...patch } });
    const { settings } = await api.updateSettings(patch);
    set({ settings });
  },

  setSidebarCollapsed(collapsed) {
    set({ sidebarCollapsed: collapsed });
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  },

  toggleSidebar() {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },

  setCommandOpen(open) {
    set({ commandOpen: open });
  },

  defaultProfile() {
    const { profiles } = get();
    return profiles.find((p) => p.isDefault) ?? profiles[0];
  },

  findProfile(id) {
    if (!id) return undefined;
    return get().profiles.find((p) => p.id === id);
  },

  findProject(id) {
    if (!id) return undefined;
    return get().projects.find((p) => p.id === id);
  },

  findModel(name) {
    if (!name) return undefined;
    return get().models.find((m) => m.name === name);
  },
}));

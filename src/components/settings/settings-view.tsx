'use client';

import { useEffect, useState } from 'react';
import {
  Boxes,
  Brain,
  Check,
  CloudUpload,
  Download,
  FolderTree,
  Loader2,
  Palette,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Server,
  Trash2,
  Upload,
  User,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/label';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SliderField } from '@/components/ui/slider';
import { SwitchRow } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { McpServer } from '@/db/schema';
import {
  api,
  type HubStatusRow,
  type ProviderHealthRow,
  type VaultStatusRow,
} from '@/lib/client/api';
import { SECRET_MASK, type Settings } from '@/lib/settings-defaults';
import { cn, formatRelative } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const providers = useAppStore((s) => s.providers);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const models = useAppStore((s) => s.models);

  const set = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    try {
      await saveSettings({ [key]: value } as Partial<Settings>);
    } catch (error) {
      toast.error('Could not save', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader title="Settings" />

      <PageBody className="max-w-3xl">
        <Tabs defaultValue="general">
          <TabsList className="mb-5 flex-wrap">
            <TabsTrigger value="general">
              <User />
              General
            </TabsTrigger>
            <TabsTrigger value="backends">
              <Server />
              Backends
            </TabsTrigger>
            <TabsTrigger value="memory">
              <Brain />
              Memory
            </TabsTrigger>
            <TabsTrigger value="tools">
              <Wrench />
              Tools
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Plug />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="appearance">
              <Palette />
              Appearance
            </TabsTrigger>
          </TabsList>

          {/* ── General ─────────────────────────────────────────────────── */}
          <TabsContent value="general" className="space-y-5">
            <Section title="About you" description="Injected into every system prompt, so the model knows who it is talking to.">
              <Field label="Name">
                <DebouncedInput
                  value={settings.userName}
                  onCommit={(v) => void set('userName', v)}
                  placeholder="Marcus"
                />
              </Field>
              <Field
                label="Context"
                hint="What should every persona know about you? Work, tools, constraints, how you like to be talked to."
              >
                <DebouncedTextarea
                  value={settings.userContext}
                  onCommit={(v) => void set('userContext', v)}
                  placeholder="Software engineer, mostly TypeScript and Rust. Prefers direct answers with no hedging. Lives in Berlin."
                  className="min-h-[8rem]"
                />
              </Field>
            </Section>

            <Section title="Conversations">
              <SwitchRow
                label="Auto-title conversations"
                hint="Generate a short title from the first exchange."
                checked={settings.autoTitle}
                onCheckedChange={(v) => void set('autoTitle', v)}
              />
              <SwitchRow
                label="Compress long conversations"
                hint="Fold older turns into a rolling summary so a long chat stays inside the context window instead of silently losing its start."
                checked={settings.autoSummarize}
                onCheckedChange={(v) => void set('autoSummarize', v)}
              />
              {settings.autoSummarize ? (
                <div className="grid gap-4 pt-2 sm:grid-cols-2">
                  <SliderField
                    label="Compress after"
                    hint="Messages before compression kicks in."
                    value={settings.summarizeAfterMessages}
                    onChange={(v) => void set('summarizeAfterMessages', Math.round(v))}
                    min={6}
                    max={120}
                    step={2}
                    format={(v) => `${Math.round(v)}`}
                  />
                  <SliderField
                    label="Keep verbatim"
                    hint="Recent turns left uncompressed."
                    value={settings.summarizeKeepRecent}
                    onChange={(v) => void set('summarizeKeepRecent', Math.round(v))}
                    min={2}
                    max={40}
                    step={1}
                    format={(v) => `${Math.round(v)}`}
                  />
                </div>
              ) : null}
            </Section>
          </TabsContent>

          {/* ── Backends ────────────────────────────────────────────────── */}
          <TabsContent value="backends" className="space-y-5">
            <Section
              title="Model backends"
              description="Forge speaks to all three at once. Whichever are running show up in the model switcher."
              action={
                <Button variant="ghost" size="sm" onClick={() => void refreshProviders()}>
                  <RefreshCcw />
                  Probe
                </Button>
              }
            >
              <div className="space-y-4">
                <ProviderRow
                  health={providers.find((p) => p.id === 'ollama')}
                  label="Ollama"
                  hint="The default. Start it with `ollama serve`."
                  value={settings.ollamaBaseUrl}
                  onCommit={(v) => void set('ollamaBaseUrl', v)}
                />
                <ProviderRow
                  health={providers.find((p) => p.id === 'llamacpp')}
                  label="llama.cpp"
                  hint="`llama-server -m model.gguf --port 8080`"
                  value={settings.llamacppBaseUrl}
                  onCommit={(v) => void set('llamacppBaseUrl', v)}
                />
                <ProviderRow
                  health={providers.find((p) => p.id === 'openai-compat')}
                  label="OpenAI-compatible"
                  hint="vLLM, LM Studio, TGI, or any gateway speaking /v1/chat/completions."
                  value={settings.openaiCompatBaseUrl}
                  onCommit={(v) => void set('openaiCompatBaseUrl', v)}
                  secret={{
                    value: settings.openaiCompatApiKey,
                    onCommit: (v) => void set('openaiCompatApiKey', v),
                  }}
                />
              </div>
            </Section>

            <Section title="Defaults">
              <Field label="Default model" hint="Used when a persona or project does not pin one.">
                <Select
                  value={settings.defaultModel || '__none'}
                  onValueChange={(v) => {
                    if (v === '__none') return;
                    const model = models.find((m) => m.name === v);
                    void saveSettings({
                      defaultModel: v,
                      defaultProvider: model?.provider ?? settings.defaultProvider,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No model selected" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No models found
                      </SelectItem>
                    ) : (
                      models
                        .filter((m) => !m.capabilities?.embedding)
                        .map((model) => (
                          <SelectItem key={model.id} value={model.name}>
                            {model.name}
                          </SelectItem>
                        ))
                    )}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="Utility model"
                hint="Small, fast model for titles, memory extraction and summaries. Leave blank to reuse the chat model — a 1-3B model here keeps background work from competing with your reply."
              >
                <Select
                  value={settings.utilityModel || '__same'}
                  onValueChange={(v) => void set('utilityModel', v === '__same' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__same">Same as chat model</SelectItem>
                    {models
                      .filter((m) => !m.capabilities?.embedding)
                      .map((model) => (
                        <SelectItem key={model.id} value={model.name}>
                          {model.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
            </Section>
          </TabsContent>

          {/* ── Memory ──────────────────────────────────────────────────── */}
          <TabsContent value="memory" className="space-y-5">
            <Section title="Long-term memory">
              <SwitchRow
                label="Enable memory"
                hint="Retrieve relevant memories into prompts, and store new ones."
                checked={settings.memoryEnabled}
                onCheckedChange={(v) => void set('memoryEnabled', v)}
              />
              <SwitchRow
                label="Extract automatically"
                hint="After each turn, mine the exchange for durable facts in the background."
                checked={settings.memoryAutoExtract}
                onCheckedChange={(v) => void set('memoryAutoExtract', v)}
                disabled={!settings.memoryEnabled}
              />
            </Section>

            <Section
              title="Retrieval"
              description="How aggressively memories are pulled into the prompt. Too many injected memories crowd out the actual conversation."
            >
              <Field
                label="Embedding model"
                hint="Pull it first: `ollama pull nomic-embed-text`. Without one Forge falls back to a local lexical embedder — memory still works, but only matches shared words, not meaning."
              >
                <DebouncedInput
                  value={settings.embeddingModel}
                  onCommit={(v) => void set('embeddingModel', v)}
                  placeholder="nomic-embed-text"
                  className="font-mono text-xs"
                />
              </Field>

              <div className="grid gap-5 pt-2 sm:grid-cols-2">
                <SliderField
                  label="Retrieve"
                  hint="Candidates fetched per turn."
                  value={settings.memoryTopK}
                  onChange={(v) => void set('memoryTopK', Math.round(v))}
                  min={1}
                  max={40}
                  step={1}
                  format={(v) => `${Math.round(v)}`}
                />
                <SliderField
                  label="Inject at most"
                  hint="Hard cap on what reaches the prompt."
                  value={settings.memoryMaxInjected}
                  onChange={(v) => void set('memoryMaxInjected', Math.round(v))}
                  min={0}
                  max={25}
                  step={1}
                  format={(v) => `${Math.round(v)}`}
                />
                <SliderField
                  label="Score floor"
                  hint="Below this, a memory is noise."
                  value={settings.memoryMinScore}
                  onChange={(v) => void set('memoryMinScore', v)}
                  min={0}
                  max={1}
                  step={0.01}
                />
                <SliderField
                  label="Meaning vs. keywords"
                  hint="1.0 is pure vector search; 0 is pure BM25."
                  value={settings.memoryVectorWeight}
                  onChange={(v) => void set('memoryVectorWeight', v)}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </div>
            </Section>
          </TabsContent>

          {/* ── Tools ───────────────────────────────────────────────────── */}
          <TabsContent value="tools" className="space-y-5">
            <Section title="Tool calling">
              <SwitchRow
                label="Enable tools"
                hint="Personas can only call the tools they were given. Models without a tool template automatically fall back to prompt-based calling."
                checked={settings.toolsEnabled}
                onCheckedChange={(v) => void set('toolsEnabled', v)}
              />
              <SliderField
                label="Max tool rounds"
                hint="Safety rail against a model looping on tool calls forever."
                value={settings.maxToolIterations}
                onChange={(v) => void set('maxToolIterations', Math.round(v))}
                min={1}
                max={10}
                step={1}
                format={(v) => `${Math.round(v)}`}
              />
            </Section>

            <Section title="Web search">
              <Field label="Provider">
                <Select
                  value={settings.searchProvider}
                  onValueChange={(v) => void set('searchProvider', v as Settings['searchProvider'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="duckduckgo">DuckDuckGo (no key)</SelectItem>
                    <SelectItem value="searxng">SearXNG (self-hosted)</SelectItem>
                    <SelectItem value="tavily">Tavily</SelectItem>
                    <SelectItem value="brave">Brave</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {settings.searchProvider === 'searxng' ? (
                <Field label="SearXNG URL">
                  <DebouncedInput
                    value={settings.searxngBaseUrl}
                    onCommit={(v) => void set('searxngBaseUrl', v)}
                    placeholder="http://localhost:8888"
                    className="font-mono text-xs"
                  />
                </Field>
              ) : null}

              {settings.searchProvider === 'tavily' ? (
                <Field label="Tavily API key">
                  <SecretInput
                    value={settings.tavilyApiKey}
                    onCommit={(v) => void set('tavilyApiKey', v)}
                  />
                </Field>
              ) : null}

              {settings.searchProvider === 'brave' ? (
                <Field label="Brave API key">
                  <SecretInput
                    value={settings.braveApiKey}
                    onCommit={(v) => void set('braveApiKey', v)}
                  />
                </Field>
              ) : null}

              <SliderField
                label="Results per search"
                value={settings.searchMaxResults}
                onChange={(v) => void set('searchMaxResults', Math.round(v))}
                min={1}
                max={15}
                step={1}
                format={(v) => `${Math.round(v)}`}
              />
            </Section>

            <McpSection />
          </TabsContent>

          {/* ── Integrations ────────────────────────────────────────────── */}
          <TabsContent value="integrations" className="space-y-5">
            <ObsidianSection settings={settings} set={set} />
            <HuggingFaceSection settings={settings} set={set} />
          </TabsContent>

          {/* ── Appearance ──────────────────────────────────────────────── */}
          <TabsContent value="appearance" className="space-y-5">
            <Section title="Appearance">
              <Field label="Theme">
                <Select
                  value={settings.theme}
                  onValueChange={(v) => void set('theme', v as Settings['theme'])}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="system">Match system</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <SliderField
                label="Text size"
                hint="Scales the whole interface."
                value={settings.fontScale}
                onChange={(v) => void set('fontScale', v)}
                min={0.85}
                max={1.3}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
              />

              <div className="space-y-1 pt-2">
                <SwitchRow
                  label="Send on Enter"
                  hint="Off means Enter adds a newline and ⌘/Ctrl+Enter sends."
                  checked={settings.sendOnEnter}
                  onCheckedChange={(v) => void set('sendOnEnter', v)}
                />
                <SwitchRow
                  label="Show token stats"
                  hint="Token counts and generation speed under each reply."
                  checked={settings.showTokenStats}
                  onCheckedChange={(v) => void set('showTokenStats', v)}
                />
                <SwitchRow
                  label="Reduce motion"
                  hint="Disable animations and transitions."
                  checked={settings.reduceMotion}
                  onCheckedChange={(v) => void set('reduceMotion', v)}
                />
              </div>
            </Section>
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sections
 * ──────────────────────────────────────────────────────────────────────────── */

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">{title}</CardTitle>
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function ProviderRow({
  health,
  label,
  hint,
  value,
  onCommit,
  secret,
}: {
  health?: ProviderHealthRow;
  label: string;
  hint: string;
  value: string;
  onCommit: (value: string) => void;
  secret?: { value: string; onCommit: (value: string) => void };
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 rounded-full',
            health?.online ? 'bg-success' : 'bg-muted-foreground/40',
          )}
        />
        <span className="text-sm font-medium">{label}</span>
        {health?.online ? (
          <Badge variant="success">
            {health.modelCount ?? 0} models · {health.latencyMs}ms
          </Badge>
        ) : (
          <Badge variant="muted">offline</Badge>
        )}
      </div>

      <DebouncedInput value={value} onCommit={onCommit} className="font-mono text-xs" />
      {secret ? <SecretInput value={secret.value} onCommit={secret.onCommit} placeholder="API key (optional)" /> : null}
      <p className="text-2xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function ObsidianSection({
  settings,
  set,
}: {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
}) {
  const [status, setStatus] = useState<VaultStatusRow | null>(null);
  const [syncing, setSyncing] = useState(false);

  const check = async () => {
    try {
      const { vault } = await api.getVaultStatus();
      setStatus(vault);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void check();
  }, [settings.obsidianVaultPath, settings.obsidianFolder]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { summary } = await api.syncVault();
      toast.success('Vault synced', {
        description: summary
          ? `${summary.conversations} conversations, ${summary.memories} memories written.`
          : undefined,
      });
      void check();
    } catch (error) {
      toast.error('Sync failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Section
      title="Obsidian"
      description="Writes plain Markdown with YAML frontmatter into one folder of your vault. No plugin, no lock-in — conversations and the memories extracted from them link to each other with [[wikilinks]]."
      action={
        status?.valid ? (
          <Button size="sm" variant="secondary" onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="animate-spin" /> : <FolderTree />}
            Sync now
          </Button>
        ) : null
      }
    >
      <Field label="Vault path" hint="The folder containing your .obsidian directory.">
        <DebouncedInput
          value={settings.obsidianVaultPath}
          onCommit={(v) => void set('obsidianVaultPath', v)}
          placeholder="/Users/you/Documents/Vault"
          className="font-mono text-xs"
        />
      </Field>

      {status?.configured && !status.valid ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive">
          {status.error}
        </p>
      ) : status?.valid ? (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <Check className="size-3.5" />
          Vault found · {status.noteCount ?? 0} notes in {status.folder}/
        </p>
      ) : null}

      <Field label="Folder" hint="Everything Forge writes lives here. The rest of your vault is never touched.">
        <DebouncedInput
          value={settings.obsidianFolder}
          onCommit={(v) => void set('obsidianFolder', v)}
          placeholder="Forge"
          className="font-mono text-xs"
        />
      </Field>

      <div className="space-y-1 pt-1">
        <SwitchRow
          label="Enable"
          checked={settings.obsidianEnabled}
          onCheckedChange={(v) => void set('obsidianEnabled', v)}
        />
        <SwitchRow
          label="Sync after every reply"
          hint="Otherwise sync manually. Unchanged notes are skipped either way."
          checked={settings.obsidianAutoSync}
          onCheckedChange={(v) => void set('obsidianAutoSync', v)}
          disabled={!settings.obsidianEnabled}
        />
        <SwitchRow
          label="Use wikilinks"
          hint="Link notes with [[double brackets]] so they connect in the graph view."
          checked={settings.obsidianWikilinks}
          onCheckedChange={(v) => void set('obsidianWikilinks', v)}
        />
      </div>
    </Section>
  );
}

function HuggingFaceSection({
  settings,
  set,
}: {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
}) {
  const [status, setStatus] = useState<HubStatusRow | null>(null);
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);

  const check = async () => {
    try {
      const { hub } = await api.getHubStatus();
      setStatus(hub);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void check();
  }, [settings.hfBackupRepo]);

  const run = async (action: 'push' | 'pull') => {
    setBusy(action);
    try {
      const { summary } = await api.syncHub(action);
      toast.success(action === 'push' ? 'Backed up' : 'Restored', {
        description: `${summary.conversations} conversations, ${summary.memories} memories.`,
      });
      void check();
    } catch (error) {
      toast.error(action === 'push' ? 'Backup failed' : 'Restore failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Hugging Face backup"
      description="Pushes conversations and memories to a private dataset repo as plain JSON — restorable with or without Forge. Repos are always created private."
      action={
        status?.valid ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => run('push')} disabled={busy !== null}>
              {busy === 'push' ? <Loader2 className="animate-spin" /> : <CloudUpload />}
              Push
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run('pull')} disabled={busy !== null}>
              {busy === 'pull' ? <Loader2 className="animate-spin" /> : <Download />}
              Pull
            </Button>
          </div>
        ) : null
      }
    >
      <Field
        label="Access token"
        hint="Needs write scope for backup, read scope for gated model downloads. Create one at huggingface.co/settings/tokens."
      >
        <SecretInput value={settings.hfToken} onCommit={(v) => void set('hfToken', v)} />
      </Field>

      <Field label="Backup repository" hint="Created private if it does not exist yet.">
        <DebouncedInput
          value={settings.hfBackupRepo}
          onCommit={(v) => void set('hfBackupRepo', v)}
          placeholder="your-name/forge-vault"
          className="font-mono text-xs"
        />
      </Field>

      {status?.configured && !status.valid ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive">
          {status.error}
        </p>
      ) : status?.valid ? (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <Check className="size-3.5" />
          Signed in as {status.user}
          {status.lastSyncAt ? ` · last synced ${formatRelative(status.lastSyncAt)}` : ''}
        </p>
      ) : null}

      <SwitchRow
        label="Back up automatically"
        hint="Push each conversation after it changes. Unchanged ones are skipped by content hash."
        checked={settings.hfAutoSync}
        onCheckedChange={(v) => void set('hfAutoSync', v)}
      />
    </Section>
  );
}

function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const refreshTools = useAppStore((s) => s.loadAll);

  const load = async () => {
    try {
      const { servers: rows } = await api.listMcpServers();
      setServers(rows);
    } catch {
      /* leave the list as-is */
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const reconnect = async (server: McpServer) => {
    const id = toast.loading(`Connecting to ${server.name}…`);
    try {
      const { connection } = await api.refreshMcpServer(server.id);
      if (connection.ok) toast.success(`${server.name} connected`, { id });
      else toast.error(`${server.name} failed`, { id, description: connection.error });
      await load();
      await refreshTools();
    } catch (error) {
      toast.error('Connection failed', {
        id,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <Section
        title="MCP servers"
        description="Model Context Protocol servers extend Forge with external tools. Their tools appear in the persona editor once discovered."
        action={
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus />
            Add server
          </Button>
        }
      >
        {servers.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No MCP servers configured.
          </p>
        ) : (
          <ul className="space-y-2">
            {servers.map((server) => (
              <li
                key={server.id}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5"
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    server.status === 'connected'
                      ? 'bg-success'
                      : server.status === 'error'
                        ? 'bg-destructive'
                        : 'bg-muted-foreground/40',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{server.name}</p>
                  <p className="truncate font-mono text-2xs text-muted-foreground">
                    {server.transport === 'stdio'
                      ? `${server.command} ${(server.args ?? []).join(' ')}`
                      : server.url}
                  </p>
                  {server.lastError ? (
                    <p className="mt-0.5 truncate text-2xs text-destructive">{server.lastError}</p>
                  ) : null}
                </div>

                <Badge variant="muted">{(server.discoveredTools ?? []).length} tools</Badge>

                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void reconnect(server)}
                  aria-label="Reconnect"
                >
                  <RefreshCcw />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    await api.deleteMcpServer(server.id);
                    await load();
                    await refreshTools();
                  }}
                  aria-label="Remove"
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <McpDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          setAdding(false);
          await load();
          await refreshTools();
        }}
      />
    </>
  );
}

function McpDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setTransport('stdio');
      setCommand('');
      setArgs('');
      setUrl('');
    }
  }, [open]);

  const add = async () => {
    setSaving(true);
    try {
      const { connection } = await api.createMcpServer({
        name: name.trim(),
        transport: transport as McpServer['transport'],
        command: transport === 'stdio' ? command.trim() : null,
        // Split on whitespace, the way a shell would.
        args: transport === 'stdio' ? args.split(/\s+/).filter(Boolean) : [],
        url: transport !== 'stdio' ? url.trim() : null,
      });

      if (connection.ok) toast.success('Server connected');
      else toast.warning('Server saved, but the connection failed', { description: connection.error });

      await onAdded();
    } catch (error) {
      toast.error('Could not add the server', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 pb-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" autoFocus />
          </Field>

          <Field label="Transport">
            <Select value={transport} onValueChange={setTransport}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio (local process)</SelectItem>
                <SelectItem value="http">HTTP (streamable)</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {transport === 'stdio' ? (
            <>
              <Field label="Command">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Arguments" hint="Space separated.">
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /Users/you/notes"
                  className="font-mono text-xs"
                />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:3001/mcp"
                className="font-mono text-xs"
              />
            </Field>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={saving || !name.trim()}>
            Add &amp; connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Inputs
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Text input that saves on blur or after a pause.
 *
 * Settings are persisted per keystroke otherwise, which means a write and a
 * cache invalidation for every character typed into a base URL.
 */
function DebouncedInput({
  value,
  onCommit,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  className?: string;
} & Omit<React.ComponentProps<'input'>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), 600);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit]);

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      className={className}
      {...props}
    />
  );
}

function DebouncedTextarea({
  value,
  onCommit,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  className?: string;
} & Omit<React.ComponentProps<'textarea'>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), 800);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit]);

  return (
    <Textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      className={className}
      {...props}
    />
  );
}

/**
 * Secret field.
 *
 * The server returns a mask rather than the real value. Leaving the mask
 * untouched is a no-op on save, so a form round-trip can never destroy a
 * working token.
 */
function SecretInput({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const isMasked = draft === SECRET_MASK;

  useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex gap-1.5">
      <Input
        type={isMasked ? 'text' : 'password'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => isMasked && setDraft('')}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
          if (!draft && value) setDraft(value);
        }}
        placeholder={placeholder ?? 'hf_…'}
        className="font-mono text-xs"
      />
      {value && !isMasked ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setDraft('');
            onCommit('');
          }}
          aria-label="Clear"
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Box,
  Circle,
  CloudDownload,
  Download,
  ExternalLink,
  Heart,
  Loader2,
  RefreshCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ModelRow } from '@/db/schema';
import { api, type HfFileRow, type HfModelSummaryRow } from '@/lib/client/api';
import { cn, formatBytes, formatCompact, formatRelative } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { providerLabel } from '@/components/chat/switchers';

export function ModelsView() {
  const models = useAppStore((s) => s.models);
  const adapters = useAppStore((s) => s.adapters);
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshModels = useAppStore((s) => s.refreshModels);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [refreshing, setRefreshing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [pulling, setPulling] = useState<{ model: string; status: string; percent: number } | null>(
    null,
  );

  const downloading = models.some((m) => m.status === 'downloading');

  // Poll only while a download is actually in flight — otherwise the page is
  // static and polling would be pure waste.
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refreshModels(false), 1200);
    return () => clearInterval(timer);
  }, [downloading, refreshModels]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshModels(true), refreshProviders()]);
    setRefreshing(false);
  };

  /** Streams `ollama pull` progress into a small inline indicator. */
  const pullFromOllama = async (name: string) => {
    setPulling({ model: name, status: 'starting', percent: 0 });
    try {
      const response = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });

      if (!response.body) throw new Error('No response stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as {
            status: string;
            completed?: number;
            total?: number;
            error?: string;
          };

          if (chunk.error) throw new Error(chunk.error);
          setPulling({
            model: name,
            status: chunk.status,
            percent: chunk.total ? ((chunk.completed ?? 0) / chunk.total) * 100 : 0,
          });
        }
      }

      toast.success(`Pulled ${name}`);
      await refreshModels(true);
    } catch (error) {
      toast.error('Pull failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setPulling(null);
    }
  };

  const setDefault = async (model: ModelRow) => {
    await saveSettings({ defaultProvider: model.provider, defaultModel: model.name });
    toast.success(`${model.name} is now the default model`);
  };

  const remove = async (model: ModelRow) => {
    try {
      await api.deleteModel(model.id);
      await refreshModels(false);
      toast.success('Model removed');
    } catch (error) {
      toast.error('Could not remove the model', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Models"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCcw className={cn(refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setBrowsing(true)}>
              <CloudDownload />
              Hugging Face
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          {providers.map((provider) => (
            <span key={provider.id} className="flex items-center gap-1.5 text-xs">
              <Circle
                className={cn(
                  'size-1.5',
                  provider.online
                    ? 'fill-success text-success'
                    : 'fill-muted-foreground/40 text-transparent',
                )}
              />
              <span className={provider.online ? 'text-foreground' : 'text-muted-foreground'}>
                {provider.label}
              </span>
              {provider.online ? (
                <span className="font-mono text-2xs text-muted-foreground">
                  {provider.modelCount ?? 0} · {provider.latencyMs}ms
                </span>
              ) : (
                <span className="text-2xs text-muted-foreground">offline</span>
              )}
            </span>
          ))}
        </div>
      </PageHeader>

      <PageBody className="space-y-6">
        {pulling ? (
          <div className="rounded-lg border border-primary/30 bg-primary/[0.05] px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="font-mono">{pulling.model}</span>
              <span className="text-muted-foreground">{pulling.status}</span>
              {pulling.percent > 0 ? (
                <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                  {pulling.percent.toFixed(0)}%
                </span>
              ) : null}
            </div>
            {pulling.percent > 0 ? (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${pulling.percent}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {models.length === 0 ? (
          <EmptyState
            icon={<Box />}
            title="No models yet"
            description="Forge talks to Ollama, llama.cpp, or any OpenAI-compatible server. Pull a model from Ollama's library, or download a GGUF straight from Hugging Face."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <QuickPull onPull={pullFromOllama} />
                <Button variant="secondary" onClick={() => setBrowsing(true)}>
                  <CloudDownload />
                  Browse Hugging Face
                </Button>
              </div>
            }
          />
        ) : (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Installed</h2>
              <QuickPull onPull={pullFromOllama} compact />
            </div>

            <div className="space-y-2">
              {models.map((model) => (
                <ModelRowCard
                  key={model.id}
                  model={model}
                  isDefault={model.name === settings.defaultModel}
                  onSetDefault={() => void setDefault(model)}
                  onFavorite={async () => {
                    await api.favoriteModel(model.id, !model.favorite);
                    await refreshModels(false);
                  }}
                  onDelete={() => void remove(model)}
                />
              ))}
            </div>
          </section>
        )}

        {adapters.length > 0 ? (
          <section>
            <h2 className="mb-3 text-sm font-semibold">LoRA adapters</h2>
            <div className="space-y-2">
              {adapters.map((adapter) => (
                <div
                  key={adapter.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{adapter.name}</p>
                    <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                      {adapter.hfRepoId} · scale {adapter.scale}
                    </p>
                  </div>
                  {adapter.status === 'downloading' ? (
                    <ProgressPill
                      done={adapter.downloadedBytes}
                      total={adapter.totalBytes}
                    />
                  ) : (
                    <Badge variant="muted">{formatBytes(adapter.sizeBytes)}</Badge>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </PageBody>

      <HuggingFaceDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        onDownloadStarted={() => void refreshModels(false)}
      />
    </>
  );
}

function ModelRowCard({
  model,
  isDefault,
  onSetDefault,
  onFavorite,
  onDelete,
}: {
  model: ModelRow;
  isDefault: boolean;
  onSetDefault: () => void;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const downloading = model.status === 'downloading';

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors',
        isDefault && 'border-primary/35',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{model.name}</span>
          {isDefault ? <Badge>default</Badge> : null}
          {model.favorite ? <Heart className="size-3 fill-primary text-primary" /> : null}
          {model.status === 'error' ? (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="size-2.5" />
              error
            </Badge>
          ) : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          <span>{providerLabel(model.provider)}</span>
          {model.parameterSize ? <span>· {model.parameterSize}</span> : null}
          {model.quantization ? <span>· {model.quantization}</span> : null}
          {model.sizeBytes > 0 ? <span>· {formatBytes(model.sizeBytes)}</span> : null}
          {model.contextLength ? <span>· {formatCompact(model.contextLength)} ctx</span> : null}
          {model.lastUsedAt ? <span>· used {formatRelative(model.lastUsedAt)}</span> : null}
          {model.capabilities?.tools ? <Badge variant="muted">tools</Badge> : null}
          {model.capabilities?.vision ? <Badge variant="muted">vision</Badge> : null}
          {model.capabilities?.embedding ? <Badge variant="muted">embedding</Badge> : null}
        </div>

        {model.statusMessage ? (
          <p className="mt-1 text-2xs text-destructive">{model.statusMessage}</p>
        ) : null}
      </div>

      {downloading ? (
        <ProgressPill done={model.downloadedBytes} total={model.totalBytes} />
      ) : (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {!isDefault && !model.capabilities?.embedding ? (
            <Button size="xs" variant="secondary" onClick={onSetDefault}>
              <Star />
              Default
            </Button>
          ) : null}
          <Button size="icon-xs" variant="ghost" onClick={onFavorite} aria-label="Favourite">
            <Heart className={cn(model.favorite && 'fill-primary text-primary')} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Remove model"
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

function ProgressPill({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="w-40 shrink-0">
      <div className="mb-1 flex items-baseline justify-between text-2xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" />
          {formatBytes(done)}
        </span>
        <span className="font-mono tabular-nums">{percent.toFixed(0)}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Inline "pull by name" box — the fastest path when you know what you want. */
function QuickPull({
  onPull,
  compact,
}: {
  onPull: (name: string) => void | Promise<void>;
  compact?: boolean;
}) {
  const [name, setName] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) void onPull(name.trim());
        setName('');
      }}
      className="flex items-center gap-1.5"
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="llama3.1:8b"
        className={cn('h-8 font-mono text-xs', compact ? 'w-44' : 'w-56')}
      />
      <Button type="submit" size="sm" variant={compact ? 'ghost' : 'default'} disabled={!name.trim()}>
        <Download />
        Pull
      </Button>
    </form>
  );
}

function HuggingFaceDialog({
  open,
  onClose,
  onDownloadStarted,
}: {
  open: boolean;
  onClose: () => void;
  onDownloadStarted: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HfModelSummaryRow[]>([]);
  const [selected, setSelected] = useState<HfModelSummaryRow | null>(null);
  const [files, setFiles] = useState<HfFileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('gguf');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
    else {
      setQuery('');
      setResults([]);
      setSelected(null);
      setFiles([]);
    }
  }, [open]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSelected(null);
    try {
      const { models } = await api.searchHfModels({
        q: query,
        library: tab === 'lora' ? undefined : tab,
        adapters: tab === 'lora',
        limit: 24,
      });
      setResults(models);
    } catch (error) {
      toast.error('Search failed', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [query, tab]);

  const openRepo = async (model: HfModelSummaryRow) => {
    setSelected(model);
    setFiles([]);
    try {
      const { files: found } = await api.listHfFiles(model.id);
      setFiles(found);
    } catch (error) {
      toast.error('Could not list files', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const download = async (file: HfFileRow) => {
    if (!selected) return;
    try {
      await api.downloadHfModel({
        repoId: selected.id,
        filename: file.path,
        asAdapter: tab === 'lora',
      });
      toast.success('Download started', {
        description: 'Progress shows on the models page. It continues in the background.',
      });
      onDownloadStarted();
      onClose();
    } catch (error) {
      toast.error('Could not start the download', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Hugging Face</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-8">
              <TabsTrigger value="gguf" className="h-6 text-xs">
                GGUF
              </TabsTrigger>
              <TabsTrigger value="safetensors" className="h-6 text-xs">
                Safetensors
              </TabsTrigger>
              <TabsTrigger value="lora" className="h-6 text-xs">
                LoRA
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="llama 3 instruct, qwen coder, abliterated…"
                className="pl-8"
              />
            </div>
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? <Loader2 className="animate-spin" /> : <Search />}
              Search
            </Button>
          </form>

          {selected ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                  ← Back
                </Button>
                <span className="truncate font-mono text-xs">{selected.id}</span>
                <a
                  href={`https://huggingface.co/${selected.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Open on Hugging Face"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </div>

              {selected.gated ? (
                <p className="rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-xs text-warning">
                  This repo is gated. Accept its licence on huggingface.co and add a read token in
                  Settings, or the download will be refused.
                </p>
              ) : null}

              {files.length === 0 ? (
                <div className="space-y-1.5">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {files.map((file) => (
                    <li
                      key={file.path}
                      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs">{file.path}</p>
                        <p className="mt-0.5 text-2xs text-muted-foreground">
                          {formatBytes(file.size)}
                          {file.quantization ? ` · ${file.quantization}` : ''}
                          {file.isShardIndex ? ' · first shard' : ''}
                        </p>
                      </div>
                      <Button size="xs" onClick={() => void download(file)}>
                        <Download />
                        Get
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : results.length > 0 ? (
            <ul className="space-y-1.5">
              {results.map((model) => (
                <li key={model.id}>
                  <button
                    onClick={() => void openRepo(model)}
                    className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs">{model.id}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                        <span>↓ {formatCompact(model.downloads)}</span>
                        <span>♥ {formatCompact(model.likes)}</span>
                        {model.gated ? <Badge variant="warning">gated</Badge> : null}
                        {model.isAdapter ? <Badge variant="muted">adapter</Badge> : null}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loading ? 'Searching…' : 'Search Hugging Face for a model to download.'}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

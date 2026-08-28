'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Box, Check, ChevronDown, Circle, Settings2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ModelRow, Profile } from '@/db/schema';
import { cn, formatBytes } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

/** Compact persona picker shown above the composer. */
export function PersonaSwitcher({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (profileId: string) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const active = profiles.find((p) => p.id === value) ?? profiles.find((p) => p.isDefault);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1.5 text-muted-foreground">
          <span style={{ color: active ? `hsl(${active.accent})` : undefined }}>
            {active?.icon ?? '◆'}
          </span>
          <span className="max-w-[10rem] truncate">{active?.name ?? 'Persona'}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Persona</DropdownMenuLabel>
        {profiles.map((profile) => (
          <PersonaRow
            key={profile.id}
            profile={profile}
            selected={profile.id === active?.id}
            onSelect={() => onChange(profile.id)}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profiles">
            <Settings2 />
            Manage personas
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonaRow({
  profile,
  selected,
  onSelect,
}: {
  profile: Profile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="items-start gap-2.5 py-2">
      <span
        className="mt-0.5 flex size-4 items-center justify-center text-sm"
        style={{ color: `hsl(${profile.accent})` }}
      >
        {profile.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium">
          {profile.name}
          {selected ? <Check className="size-3 text-primary" /> : null}
        </p>
        {profile.description ? (
          <p className="truncate text-xs text-muted-foreground">{profile.description}</p>
        ) : null}
      </div>
      <span className="mt-0.5 shrink-0 font-mono text-2xs text-muted-foreground">
        {profile.temperature.toFixed(1)}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Model picker, grouped by backend.
 *
 * Embedding models are filtered out — they cannot chat, and listing them here
 * only invites a confusing failure.
 */
export function ModelSwitcher({
  value,
  onChange,
  className,
}: {
  value: string | null | undefined;
  onChange: (model: { provider: string; name: string }) => void;
  className?: string;
}) {
  const models = useAppStore((s) => s.models);
  const providers = useAppStore((s) => s.providers);
  const defaultModel = useAppStore((s) => s.settings.defaultModel);

  const active = models.find((m) => m.name === (value ?? defaultModel));

  const grouped = useMemo(() => {
    const chatModels = models.filter((m) => !m.capabilities?.embedding && m.status !== 'missing');
    const byProvider = new Map<string, ModelRow[]>();
    for (const model of chatModels) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()];
  }, [models]);

  const anyOnline = providers.some((p) => p.online);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className={cn('gap-1.5 text-muted-foreground', className)}>
          <Box className="size-3" />
          <span className="max-w-[14rem] truncate font-mono">
            {active?.displayName ?? active?.name ?? value ?? defaultModel ?? 'No model'}
          </span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-h-[26rem] w-80 overflow-y-auto">
        {grouped.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="text-sm font-medium">No models found</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {anyOnline
                ? 'Your backend is running but has no models. Pull one first.'
                : 'Start Ollama or llama.cpp, or add a model server in Settings.'}
            </p>
            <Button asChild size="sm" variant="secondary" className="mt-3">
              <Link href="/models">
                <Sparkles />
                Get a model
              </Link>
            </Button>
          </div>
        ) : (
          grouped.map(([provider, list]) => (
            <div key={provider}>
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <ProviderDot provider={provider} />
                {providerLabel(provider)}
              </DropdownMenuLabel>

              {list.map((model) => (
                <DropdownMenuItem
                  key={model.id}
                  onSelect={() => onChange({ provider: model.provider, name: model.name })}
                  className="items-start gap-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate font-mono text-xs">
                      {model.name}
                      {model.name === active?.name ? (
                        <Check className="size-3 shrink-0 text-primary" />
                      ) : null}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                      {model.parameterSize ? <span>{model.parameterSize}</span> : null}
                      {model.quantization ? <span>{model.quantization}</span> : null}
                      {model.sizeBytes > 0 ? <span>{formatBytes(model.sizeBytes)}</span> : null}
                      {model.capabilities?.tools ? (
                        <Badge variant="muted" className="px-1 py-0">
                          tools
                        </Badge>
                      ) : null}
                      {model.capabilities?.vision ? (
                        <Badge variant="muted" className="px-1 py-0">
                          vision
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/models">
            <Settings2 />
            Manage models
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderDot({ provider }: { provider: string }) {
  const providers = useAppStore((s) => s.providers);
  const health = providers.find((p) => p.id === provider);

  return (
    <Circle
      className={cn(
        'size-1.5 shrink-0',
        health?.online ? 'fill-success text-success' : 'fill-muted-foreground/40 text-transparent',
      )}
    />
  );
}

export function providerLabel(provider: string): string {
  return (
    { ollama: 'Ollama', llamacpp: 'llama.cpp', 'openai-compat': 'Model server' }[provider] ??
    provider
  );
}

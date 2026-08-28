'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, Copy, Plus, Sparkles, Star, Trash2, Wrench } from 'lucide-react';
import { toast } from 'sonner';

import { PageBody, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/label';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SliderField } from '@/components/ui/slider';
import { SwitchRow } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Profile } from '@/db/schema';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

/** Accent presets, chosen to stay distinguishable in both themes. */
const ACCENTS = [
  { label: 'Ember', value: '22 94% 56%' },
  { label: 'Cyan', value: '190 90% 50%' },
  { label: 'Violet', value: '265 85% 68%' },
  { label: 'Green', value: '142 70% 45%' },
  { label: 'Rose', value: '350 85% 60%' },
  { label: 'Pink', value: '320 80% 65%' },
  { label: 'Amber', value: '38 92% 55%' },
];

export function ProfilesView() {
  return (
    <Suspense fallback={null}>
      <ProfilesInner />
    </Suspense>
  );
}

function ProfilesInner() {
  const params = useSearchParams();

  const profiles = useAppStore((s) => s.profiles);
  const refreshProfiles = useAppStore((s) => s.refreshProfiles);
  const models = useAppStore((s) => s.models);
  const tools = useAppStore((s) => s.tools);

  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);

  // Deep link from the command palette: /profiles?edit=<id>
  useEffect(() => {
    const id = params.get('edit');
    if (id) {
      const target = profiles.find((p) => p.id === id);
      if (target) setEditing(target);
    }
  }, [params, profiles]);

  const setDefault = async (profile: Profile) => {
    try {
      await api.updateProfile(profile.id, { isDefault: true });
      await refreshProfiles();
      toast.success(`${profile.name} is now the default persona`);
    } catch (error) {
      toast.error('Could not set the default', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const duplicate = async (profile: Profile) => {
    try {
      await api.createProfile({
        ...profile,
        name: `${profile.name} copy`,
        isDefault: false,
        id: undefined as never,
      });
      await refreshProfiles();
      toast.success('Persona duplicated');
    } catch (error) {
      toast.error('Could not duplicate', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const remove = async (profile: Profile) => {
    try {
      await api.deleteProfile(profile.id);
      await refreshProfiles();
      toast.success('Persona deleted');
    } catch (error) {
      toast.error('Could not delete', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Personas"
        description="Each persona is a complete configuration: who the model is, which model runs it, how it samples, and which tools it may reach for."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New persona
          </Button>
        }
      />

      <PageBody>
        {profiles.length === 0 ? (
          <EmptyState
            icon={<Sparkles />}
            title="No personas yet"
            description="A persona bundles a system prompt with sampling settings and tool access, so switching modes is one click rather than a re-typed prompt."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus />
                Create one
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {profiles.map((profile) => (
              <article
                key={profile.id}
                className={cn(
                  'group relative flex flex-col rounded-xl border border-border bg-card p-4 transition-colors',
                  profile.isDefault && 'border-primary/35',
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-lg"
                    style={{ color: `hsl(${profile.accent})` }}
                  >
                    {profile.icon}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-sm font-semibold">{profile.name}</h3>
                      {profile.isDefault ? <Badge>default</Badge> : null}
                    </div>
                    {profile.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {profile.description}
                      </p>
                    ) : null}
                  </div>
                </div>

                <p className="mt-3 line-clamp-3 rounded-md bg-muted/40 px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted-foreground">
                  {profile.systemPrompt.split('\n')[0] || 'No system prompt'}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                  <Badge variant="muted">temp {profile.temperature.toFixed(2)}</Badge>
                  <Badge variant="muted">{profile.maxTokens} max</Badge>
                  {profile.model ? (
                    <Badge variant="outline" className="font-mono">
                      {profile.model}
                    </Badge>
                  ) : (
                    <Badge variant="outline">inherits model</Badge>
                  )}
                  {profile.enabledTools?.length ? (
                    <Badge variant="muted" className="gap-1">
                      <Wrench className="size-2.5" />
                      {profile.enabledTools.length}
                    </Badge>
                  ) : null}
                  {profile.memoryRead ? <Badge variant="muted">memory</Badge> : null}
                </div>

                <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3">
                  <Button size="xs" variant="secondary" onClick={() => setEditing(profile)}>
                    Edit
                  </Button>
                  {!profile.isDefault ? (
                    <Button size="xs" variant="ghost" onClick={() => void setDefault(profile)}>
                      <Star />
                      Default
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void duplicate(profile)}
                    aria-label="Duplicate"
                  >
                    <Copy />
                  </Button>
                  {profiles.length > 1 ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() => void remove(profile)}
                      aria-label="Delete"
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </PageBody>

      <ProfileDialog
        open={creating || editing !== null}
        profile={editing}
        models={models}
        tools={tools}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={async () => {
          setCreating(false);
          setEditing(null);
          await refreshProfiles();
        }}
      />
    </>
  );
}

function ProfileDialog({
  open,
  profile,
  models,
  tools,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: Profile | null;
  models: ReturnType<typeof useAppStore.getState>['models'];
  tools: ReturnType<typeof useAppStore.getState>['tools'];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Partial<Profile>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(
      profile ?? {
        name: '',
        description: '',
        icon: '◆',
        accent: ACCENTS[0].value,
        systemPrompt: '',
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        repeatPenalty: 1.1,
        maxTokens: 4096,
        enabledTools: [],
        memoryRead: true,
        memoryWrite: true,
      },
    );
  }, [open, profile]);

  const toolsByCategory = useMemo(() => {
    const groups = new Map<string, typeof tools>();
    for (const tool of tools) {
      const list = groups.get(tool.category) ?? [];
      list.push(tool);
      groups.set(tool.category, list);
    }
    return [...groups.entries()];
  }, [tools]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const toggleTool = (name: string) => {
    const current = draft.enabledTools ?? [];
    set(
      'enabledTools',
      current.includes(name) ? current.filter((t) => t !== name) : [...current, name],
    );
  };

  const save = async () => {
    if (!draft.name?.trim()) {
      toast.error('Give the persona a name');
      return;
    }

    setSaving(true);
    try {
      if (profile) await api.updateProfile(profile.id, draft);
      else await api.createProfile(draft as Profile & { name: string });
      toast.success(profile ? 'Persona updated' : 'Persona created');
      await onSaved();
    } catch (error) {
      toast.error('Could not save', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{profile ? `Edit ${profile.name}` : 'New persona'}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <Tabs defaultValue="identity">
            <TabsList>
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="sampling">Sampling</TabsTrigger>
              <TabsTrigger value="tools">Tools &amp; memory</TabsTrigger>
            </TabsList>

            <TabsContent value="identity" className="space-y-4 pb-2">
              <div className="flex gap-3">
                <Field label="Icon" className="w-20">
                  <Input
                    value={draft.icon ?? ''}
                    onChange={(e) => set('icon', e.target.value.slice(0, 2))}
                    className="text-center text-lg"
                  />
                </Field>
                <Field label="Name" className="flex-1">
                  <Input
                    value={draft.name ?? ''}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="Research"
                  />
                </Field>
              </div>

              <Field label="Description" hint="One line, shown in the switcher.">
                <Input
                  value={draft.description ?? ''}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Slow, cited, source-driven."
                />
              </Field>

              <Field label="Accent">
                <div className="flex flex-wrap gap-1.5">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.value}
                      onClick={() => set('accent', accent.value)}
                      className={cn(
                        'size-7 rounded-md border-2 transition-transform hover:scale-110',
                        draft.accent === accent.value
                          ? 'border-foreground'
                          : 'border-transparent',
                      )}
                      style={{ background: `hsl(${accent.value})` }}
                      title={accent.label}
                      aria-label={accent.label}
                    />
                  ))}
                </div>
              </Field>

              <Field
                label="System prompt"
                hint="This is the persona. Be specific about how it should talk and think — vague prompts produce vague assistants."
              >
                <Textarea
                  value={draft.systemPrompt ?? ''}
                  onChange={(e) => set('systemPrompt', e.target.value)}
                  className="min-h-[12rem] resize-y font-mono text-xs leading-relaxed"
                  placeholder="You are…"
                />
              </Field>

              <Field label="Model" hint="Leave on inherit to follow the app default.">
                <Select
                  value={draft.model ?? '__inherit'}
                  onValueChange={(value) => {
                    if (value === '__inherit') {
                      set('model', null);
                      set('provider', null);
                    } else {
                      const model = models.find((m) => m.name === value);
                      set('model', value);
                      set('provider', (model?.provider ?? null) as Profile['provider']);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__inherit">Inherit app default</SelectItem>
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
            </TabsContent>

            <TabsContent value="sampling" className="space-y-5 pb-2">
              <SliderField
                label="Temperature"
                hint="Low is reproducible and precise. High is varied and surprising. Above ~1.2 most local models start to lose coherence."
                value={draft.temperature ?? 0.8}
                onChange={(v) => set('temperature', v)}
                min={0}
                max={2}
                step={0.05}
              />
              <SliderField
                label="Top P"
                hint="Nucleus sampling. Caps the cumulative probability mass considered at each step."
                value={draft.topP ?? 0.95}
                onChange={(v) => set('topP', v)}
                min={0}
                max={1}
                step={0.01}
              />
              <SliderField
                label="Top K"
                hint="Hard cap on how many candidate tokens are considered. 0 disables it."
                value={draft.topK ?? 40}
                onChange={(v) => set('topK', Math.round(v))}
                min={0}
                max={100}
                step={1}
                format={(v) => String(Math.round(v))}
              />
              <SliderField
                label="Repeat penalty"
                hint="Above 1 discourages repetition. Push it too high and the model avoids necessary words."
                value={draft.repeatPenalty ?? 1.1}
                onChange={(v) => set('repeatPenalty', v)}
                min={0.8}
                max={1.5}
                step={0.01}
              />

              <div className="grid grid-cols-2 gap-4">
                <Field label="Max tokens" hint="Upper bound on one reply.">
                  <Input
                    value={String(draft.maxTokens ?? 4096)}
                    onChange={(e) => set('maxTokens', Number(e.target.value) || 4096)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="Context window" hint="Blank uses the model's own.">
                  <Input
                    value={draft.contextWindow ? String(draft.contextWindow) : ''}
                    onChange={(e) =>
                      set('contextWindow', e.target.value ? Number(e.target.value) : null)
                    }
                    placeholder="auto"
                    inputMode="numeric"
                  />
                </Field>
              </div>
            </TabsContent>

            <TabsContent value="tools" className="space-y-4 pb-2">
              <div className="space-y-1">
                <p className="text-sm font-medium">Tools</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Only the tools you enable are offered to the model. Fewer, well-chosen tools
                  produce better decisions than a long list.
                </p>
              </div>

              {toolsByCategory.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No tools available. Add an MCP server in Settings to extend this list.
                </p>
              ) : (
                <div className="space-y-3">
                  {toolsByCategory.map(([category, list]) => (
                    <div key={category}>
                      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {category}
                      </p>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {list.map((tool) => {
                          const enabled = (draft.enabledTools ?? []).includes(tool.name);
                          return (
                            <button
                              key={tool.name}
                              onClick={() => toggleTool(tool.name)}
                              className={cn(
                                'flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                                enabled
                                  ? 'border-primary/40 bg-primary/[0.06]'
                                  : 'border-border hover:bg-accent/50',
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
                                  enabled
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border',
                                )}
                              >
                                {enabled ? <Check className="size-2.5" /> : null}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-xs">{tool.name}</span>
                                <span className="mt-0.5 line-clamp-2 block text-2xs leading-snug text-muted-foreground">
                                  {tool.description}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1 border-t border-border pt-4">
                <SwitchRow
                  label="Read memory"
                  hint="Inject relevant long-term memories into this persona's prompts."
                  checked={draft.memoryRead ?? true}
                  onCheckedChange={(v) => set('memoryRead', v)}
                />
                <SwitchRow
                  label="Write memory"
                  hint="Mine conversations with this persona for durable facts."
                  checked={draft.memoryWrite ?? true}
                  onCheckedChange={(v) => set('memoryWrite', v)}
                />
              </div>
            </TabsContent>
          </Tabs>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {profile ? 'Save changes' : 'Create persona'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

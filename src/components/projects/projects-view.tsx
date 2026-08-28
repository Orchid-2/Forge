'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FolderOpen, MessageSquarePlus, Pin, Plus, Settings2, Trash2 } from 'lucide-react';
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
import type { Project } from '@/db/schema';
import { api, type ProjectWithCounts } from '@/lib/client/api';
import { cn, formatRelative } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

const ACCENTS = ['190 90% 50%', '22 94% 56%', '265 85% 68%', '142 70% 45%', '350 85% 60%', '38 92% 55%'];

export function ProjectsView() {
  return (
    <Suspense fallback={null}>
      <ProjectsInner />
    </Suspense>
  );
}

function ProjectsInner() {
  const params = useSearchParams();
  const projects = useAppStore((s) => s.projects);
  const refreshProjects = useAppStore((s) => s.refreshProjects);

  const [creating, setCreating] = useState(params.get('new') === '1');
  const [editing, setEditing] = useState<Project | null>(null);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project groups related chats under shared instructions, a default model, and its own memory scope."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New project
          </Button>
        }
      />

      <PageBody>
        {projects.length === 0 ? (
          <EmptyState
            icon={<FolderOpen />}
            title="No projects yet"
            description="Projects keep long-running work together. Every chat inside one inherits its instructions and default model, and memories captured there stay scoped to it rather than leaking into unrelated conversations."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus />
                Create a project
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onEdit={() => setEditing(project)} />
            ))}
          </div>
        )}
      </PageBody>

      <ProjectDialog
        open={creating || editing !== null}
        project={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={async () => {
          setCreating(false);
          setEditing(null);
          await refreshProjects();
        }}
      />
    </>
  );
}

function ProjectCard({
  project,
  onEdit,
}: {
  project: ProjectWithCounts;
  onEdit: () => void;
}) {
  return (
    <article className="group relative flex flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30">
      <Link href={`/projects/${project.id}`} className="flex-1">
        <div className="flex items-start gap-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-lg"
            style={{ color: `hsl(${project.accent})` }}
          >
            {project.icon}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 truncate text-sm font-semibold">
              {project.name}
              {project.pinned ? <Pin className="size-3 shrink-0 text-primary" /> : null}
            </h3>
            {project.description ? (
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {project.description}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge variant="muted">{project.conversationCount} chats</Badge>
          <Badge variant="muted">{project.memoryCount} memories</Badge>
          {project.defaultModel ? (
            <Badge variant="outline" className="font-mono">
              {project.defaultModel}
            </Badge>
          ) : null}
        </div>
      </Link>

      <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3">
        <Button asChild size="xs" variant="secondary">
          <Link href={`/chat?project=${project.id}`}>
            <MessageSquarePlus />
            New chat
          </Link>
        </Button>
        <Button size="xs" variant="ghost" onClick={onEdit} aria-label="Project settings">
          <Settings2 />
        </Button>
        <span className="ml-auto text-2xs text-muted-foreground">
          {formatRelative(project.updatedAt)}
        </span>
      </div>
    </article>
  );
}

function ProjectDialog({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const router = useRouter();
  const profiles = useAppStore((s) => s.profiles);
  const models = useAppStore((s) => s.models);

  const [draft, setDraft] = useState<Partial<Project>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(
      project ?? {
        name: '',
        description: '',
        icon: '▲',
        accent: ACCENTS[0],
        systemPrompt: '',
        memoryScoped: true,
      },
    );
  }, [open, project]);

  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!draft.name?.trim()) {
      toast.error('Give the project a name');
      return;
    }

    setSaving(true);
    try {
      if (project) await api.updateProject(project.id, draft);
      else await api.createProject(draft as Project & { name: string });
      toast.success(project ? 'Project updated' : 'Project created');
      await onSaved();
    } catch (error) {
      toast.error('Could not save', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    try {
      // Conversations detach to the top level rather than being destroyed.
      await api.deleteProject(project.id, false);
      toast.success('Project deleted', {
        description: 'Its conversations were kept and moved to the top level.',
      });
      onClose();
      await onSaved();
      router.push('/projects');
    } catch (error) {
      toast.error('Could not delete', {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{project ? `Edit ${project.name}` : 'New project'}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 pb-2">
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
                placeholder="Thesis"
                autoFocus
              />
            </Field>
          </div>

          <Field label="Description">
            <Input
              value={draft.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Everything for the dissertation."
            />
          </Field>

          <Field label="Accent">
            <div className="flex flex-wrap gap-1.5">
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  onClick={() => set('accent', accent)}
                  className={cn(
                    'size-7 rounded-md border-2 transition-transform hover:scale-110',
                    draft.accent === accent ? 'border-foreground' : 'border-transparent',
                  )}
                  style={{ background: `hsl(${accent})` }}
                  aria-label={accent}
                />
              ))}
            </div>
          </Field>

          <Field
            label="Project instructions"
            hint="Layered on top of the persona prompt for every chat in this project — context about the work, not about who the model is."
          >
            <Textarea
              value={draft.systemPrompt ?? ''}
              onChange={(e) => set('systemPrompt', e.target.value)}
              className="min-h-[8rem] resize-y font-mono text-xs leading-relaxed"
              placeholder="This project is a dissertation on…"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Default persona">
              <Select
                value={draft.defaultProfileId ?? '__none'}
                onValueChange={(v) => set('defaultProfileId', v === '__none' ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No default</SelectItem>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.icon} {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Default model">
              <Select
                value={draft.defaultModel ?? '__inherit'}
                onValueChange={(v) => {
                  if (v === '__inherit') {
                    set('defaultModel', null);
                    set('defaultProvider', null);
                  } else {
                    const model = models.find((m) => m.name === v);
                    set('defaultModel', v);
                    set('defaultProvider', (model?.provider ?? null) as Project['defaultProvider']);
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
          </div>
        </DialogBody>

        <DialogFooter>
          {project ? (
            <Button
              variant="ghost"
              onClick={remove}
              className="mr-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {project ? 'Save changes' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

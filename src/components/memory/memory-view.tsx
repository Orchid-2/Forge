'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, Check, Pencil, Pin, PinOff, Plus, RefreshCcw, Search, Sparkles, Trash2, X } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { api, type ScoredMemoryRow } from '@/lib/client/api';
import { cn, formatRelative } from '@/lib/utils';

const KINDS = ['fact', 'preference', 'event', 'entity', 'instruction', 'insight', 'summary'] as const;

/** Kind → chart token, so memory colours match the dashboard's. */
const KIND_COLOR: Record<string, string> = {
  fact: 'var(--chart-2)',
  preference: 'var(--chart-1)',
  event: 'var(--chart-3)',
  entity: 'var(--chart-4)',
  instruction: 'var(--chart-5)',
  insight: 'var(--chart-2)',
  summary: 'var(--muted-foreground)',
};

/**
 * The memory browser.
 *
 * Search runs through the same hybrid retrieval the chat pipeline uses, so what
 * is listed here is what the model would actually recall — which is the whole
 * point of giving memory a UI.
 */
export function MemoryView() {
  const params = useSearchParams();
  const highlightId = params.get('highlight');

  const [memories, setMemories] = useState<ScoredMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [editing, setEditing] = useState<ScoredMemoryRow | null>(null);
  const [creating, setCreating] = useState(params.get('new') === '1');

  const load = useCallback(async (term: string, kindFilter: string, onlyPinned: boolean) => {
    setLoading(true);
    try {
      const { memories: rows } = await api.listMemories({
        q: term || undefined,
        kind: kindFilter === 'all' ? undefined : kindFilter,
        pinned: onlyPinned || undefined,
        limit: 200,
      });
      setMemories(rows);
    } catch (error) {
      toast.error('Could not load memories', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced so typing does not fire a retrieval per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(query, kind, pinnedOnly), 220);
    return () => clearTimeout(timer);
  }, [query, kind, pinnedOnly, load]);

  const stats = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const memory of memories) byKind.set(memory.kind, (byKind.get(memory.kind) ?? 0) + 1);
    return {
      total: memories.length,
      pinned: memories.filter((m) => m.pinned).length,
      byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [memories]);

  const togglePin = async (memory: ScoredMemoryRow) => {
    setMemories((rows) => rows.map((m) => (m.id === memory.id ? { ...m, pinned: !m.pinned } : m)));
    try {
      await api.updateMemory(memory.id, { pinned: !memory.pinned });
    } catch {
      setMemories((rows) =>
        rows.map((m) => (m.id === memory.id ? { ...m, pinned: memory.pinned } : m)),
      );
      toast.error('Could not update the memory');
    }
  };

  const remove = async (memory: ScoredMemoryRow) => {
    setMemories((rows) => rows.filter((m) => m.id !== memory.id));
    try {
      await api.deleteMemory(memory.id);
      toast.success('Memory deleted');
    } catch {
      void load(query, kind, pinnedOnly);
      toast.error('Could not delete the memory');
    }
  };

  const reembed = async () => {
    const id = toast.loading('Re-embedding memories…');
    try {
      const { updated } = await api.reembedMemories();
      toast.success(
        updated > 0
          ? `Re-embedded ${updated} ${updated === 1 ? 'memory' : 'memories'}`
          : 'Everything already uses the current embedding model',
        { id },
      );
      void load(query, kind, pinnedOnly);
    } catch (error) {
      toast.error('Re-embedding failed', {
        id,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Memory"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={reembed}
              title="Upgrade memories captured without an embedding model"
            >
              <RefreshCcw />
              Re-embed
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              Add memory
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the way the model would recall…"
              className="h-8 pl-8 text-xs"
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={pinnedOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => setPinnedOnly((v) => !v)}
          >
            <Pin />
            Pinned
          </Button>
        </div>
      </PageHeader>

      <PageBody>
        {!loading && memories.length > 0 ? (
          <div className="mb-5 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>
              <strong className="font-mono text-sm text-foreground">{stats.total}</strong>{' '}
              {query ? 'matching' : 'memories'}
            </span>
            {stats.pinned > 0 ? (
              <span className="flex items-center gap-1">
                <Pin className="size-3 text-primary" />
                {stats.pinned} pinned
              </span>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {stats.byKind.map(([k, count]) => (
                <button
                  key={k}
                  onClick={() => setKind(kind === k ? 'all' : k)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-2xs transition-colors',
                    kind === k
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border hover:bg-accent',
                  )}
                >
                  {k} {count}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : memories.length === 0 ? (
          <EmptyState
            icon={<Brain />}
            title={query ? 'Nothing matches that' : 'No memories yet'}
            description={
              query
                ? 'Try different words. Retrieval blends meaning with exact terms, so both a paraphrase and a specific name should find something.'
                : 'Forge extracts durable facts from your conversations on its own. You can also write one by hand — useful for anything you would otherwise keep repeating.'
            }
            action={
              query ? (
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : (
                <Button onClick={() => setCreating(true)}>
                  <Plus />
                  Add your first memory
                </Button>
              )
            }
          />
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {memories.map((memory) => (
                <motion.li
                  key={memory.id}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                >
                  <MemoryCard
                    memory={memory}
                    highlighted={memory.id === highlightId}
                    onTogglePin={() => void togglePin(memory)}
                    onEdit={() => setEditing(memory)}
                    onDelete={() => void remove(memory)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </PageBody>

      <MemoryDialog
        open={creating || editing !== null}
        memory={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load(query, kind, pinnedOnly);
        }}
      />
    </>
  );
}

function MemoryCard({
  memory,
  highlighted,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  memory: ScoredMemoryRow;
  highlighted?: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative rounded-lg border border-border bg-card px-4 py-3 transition-colors',
        memory.pinned && 'border-primary/30',
        highlighted && 'ring-2 ring-primary/40',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 size-2 shrink-0 rounded-full"
          style={{ background: `hsl(${KIND_COLOR[memory.kind] ?? 'var(--muted-foreground)'})` }}
          title={memory.kind}
        />

        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed">{memory.content}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
            <Badge variant="muted">{memory.kind}</Badge>
            <span title="Importance">imp {memory.importance.toFixed(2)}</span>
            <span>· {memory.source}</span>
            <span>· {formatRelative(memory.createdAt)}</span>
            {memory.accessCount > 0 ? <span>· recalled {memory.accessCount}×</span> : null}
            {memory.score !== undefined && memory.score > 0 ? (
              <Badge variant="outline" className="font-mono">
                {memory.score.toFixed(2)} {memory.reason}
              </Badge>
            ) : null}
            {memory.embeddingModel?.endsWith(':lexical') ? (
              <Badge
                variant="warning"
                title="Captured with no embedding model available. Re-embed to upgrade it."
              >
                lexical
              </Badge>
            ) : null}
            {(memory.tags ?? []).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5">
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label={memory.pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
            {memory.pinned ? <PinOff className="text-primary" /> : <Pin />}
          </IconButton>
          <IconButton label="Edit" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label="Delete" destructive onClick={onDelete}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5',
        destructive && 'hover:bg-destructive/10 hover:text-destructive',
      )}
    >
      {children}
    </button>
  );
}

function MemoryDialog({
  open,
  memory,
  onClose,
  onSaved,
}: {
  open: boolean;
  memory: ScoredMemoryRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('fact');
  const [importance, setImportance] = useState(0.6);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setContent(memory?.content ?? '');
    setKind(memory?.kind ?? 'fact');
    setImportance(memory?.importance ?? 0.6);
    setTags((memory?.tags ?? []).join(', '));
  }, [open, memory]);

  const save = async () => {
    const text = content.trim();
    if (text.length < 5) {
      toast.error('A memory needs to say something');
      return;
    }

    setSaving(true);
    try {
      const parsedTags = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      if (memory) {
        await api.updateMemory(memory.id, {
          content: text,
          kind: kind as never,
          importance,
          tags: parsedTags,
        });
        toast.success('Memory updated');
      } else {
        const result = await api.createMemory({
          content: text,
          kind,
          importance,
          tags: parsedTags,
        });
        toast.success(
          result.deduplicated
            ? 'You already knew that — reinforced the existing memory instead'
            : 'Memory saved',
        );
      }
      onSaved();
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{memory ? 'Edit memory' : 'New memory'}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-5 pb-2">
          <Field
            label="Memory"
            hint="Write it as a standalone sentence in the third person. It has to make sense with no surrounding context, because that is how the model reads it."
          >
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Marcus prefers terse answers and dislikes being asked things he already answered."
              className="min-h-[7rem] resize-y"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Kind">
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Tags" hint="Comma separated.">
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="work, tooling"
              />
            </Field>
          </div>

          <SliderField
            label="Importance"
            hint="Higher ranks it above other memories during retrieval, and keeps it when older ones are pruned."
            value={importance}
            onChange={setImportance}
            min={0}
            max={1}
            step={0.05}
          />
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Sparkles className="animate-pulse" /> : <Check />}
            {memory ? 'Save changes' : 'Save memory'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

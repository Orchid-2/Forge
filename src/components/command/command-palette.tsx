'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  BarChart3,
  Boxes,
  Brain,
  CornerDownLeft,
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Settings,
  Sparkles,
  User,
} from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api, type SearchResponse } from '@/lib/client/api';
import { cn, debounce, formatRelative, truncate } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useChatStore } from '@/store/chat-store';

/**
 * Command palette (⌘K).
 *
 * Two modes in one surface: with no query it lists actions and personas; with a
 * query it becomes a live search over conversations, message bodies and
 * memories. cmdk handles the filtering of static items; server results are
 * appended unfiltered because the server already ranked them.
 */
export function CommandPalette() {
  const router = useRouter();

  const open = useAppStore((s) => s.commandOpen);
  const setOpen = useAppStore((s) => s.setCommandOpen);
  const profiles = useAppStore((s) => s.profiles);
  const projects = useAppStore((s) => s.projects);

  const conversations = useChatStore((s) => s.conversations);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  // Guards against an older, slower request overwriting a newer one's results.
  const requestId = useRef(0);

  const runSearch = useMemo(
    () =>
      debounce((term: string) => {
        const id = ++requestId.current;
        if (term.trim().length < 2) {
          setResults(null);
          setSearching(false);
          return;
        }

        setSearching(true);
        api
          .search(term)
          .then((response) => {
            if (id === requestId.current) setResults(response);
          })
          .catch(() => {
            if (id === requestId.current) setResults(null);
          })
          .finally(() => {
            if (id === requestId.current) setSearching(false);
          });
      }, 180),
    [],
  );

  useEffect(() => {
    runSearch(query);
  }, [query, runSearch]);

  // ⌘K / Ctrl+K toggles; ⌘N starts a chat; ⌘\ collapses the sidebar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;

      if (event.key === 'k') {
        event.preventDefault();
        setOpen(!open);
      } else if (event.key === 'n') {
        event.preventDefault();
        router.push('/chat');
      } else if (event.key === '\\') {
        event.preventDefault();
        useAppStore.getState().toggleSidebar();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen, router]);

  // Reset the query when the palette closes, so it reopens clean.
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => {
        setQuery('');
        setResults(null);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router, setOpen],
  );

  const recent = conversations.slice(0, 6);
  const hasResults =
    results &&
    (results.conversations.length > 0 ||
      results.messages.length > 0 ||
      results.memories.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        className="max-w-xl gap-0 overflow-hidden p-0"
        // cmdk owns keyboard navigation; letting Radix autofocus would fight it.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        <Command
          shouldFilter={!query.trim()}
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search conversations, memories, or jump to…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {searching ? (
              <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-primary" />
            ) : null}
          </div>

          <Command.List className="max-h-[22rem] overflow-y-auto overscroll-contain p-2">
            <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
              {query.trim().length < 2 ? 'Keep typing to search…' : 'No matches.'}
            </Command.Empty>

            {/* ── Query mode: server results ─────────────────────────────── */}
            {hasResults ? (
              <>
                {results.conversations.length > 0 ? (
                  <Command.Group heading="Conversations">
                    {results.conversations.map((c) => (
                      <Item key={c.id} onSelect={() => go(`/chat/${c.id}`)}>
                        <MessageSquare className="size-4 text-muted-foreground" />
                        <span className="flex-1 truncate">{c.title}</span>
                        <Meta>{formatRelative(c.lastMessageAt)}</Meta>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}

                {results.messages.length > 0 ? (
                  <Command.Group heading="In messages">
                    {results.messages.map((m) => (
                      <Item
                        key={m.id}
                        onSelect={() => go(`/chat/${m.conversationId}#${m.id}`)}
                        className="items-start"
                      >
                        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-muted-foreground">
                            {m.conversationTitle ?? 'Conversation'}
                          </p>
                          <p className="line-clamp-2 text-sm leading-snug">
                            {truncate(m.content, 160)}
                          </p>
                        </div>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}

                {results.memories.length > 0 ? (
                  <Command.Group heading="Memories">
                    {results.memories.map((m) => (
                      <Item key={m.id} onSelect={() => go(`/memory?highlight=${m.id}`)}>
                        <Brain className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{m.title ?? truncate(m.content, 70)}</span>
                        <Meta>{m.kind}</Meta>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}
              </>
            ) : null}

            {/* ── Default mode: actions and navigation ───────────────────── */}
            {!query.trim() ? (
              <>
                <Command.Group heading="Actions">
                  <Item onSelect={() => go('/chat')}>
                    <MessageSquarePlus className="size-4 text-primary" />
                    New chat
                    <Kbd>⌘N</Kbd>
                  </Item>
                  <Item onSelect={() => go('/projects?new=1')}>
                    <FolderOpen className="size-4 text-muted-foreground" />
                    New project
                  </Item>
                  <Item onSelect={() => go('/memory?new=1')}>
                    <Brain className="size-4 text-muted-foreground" />
                    Add memory
                  </Item>
                </Command.Group>

                {profiles.length > 0 ? (
                  <Command.Group heading="Personas">
                    {profiles.slice(0, 6).map((profile) => (
                      <Item
                        key={profile.id}
                        value={`persona ${profile.name} ${profile.description ?? ''}`}
                        onSelect={() => go(`/profiles?edit=${profile.id}`)}
                      >
                        <span
                          className="flex size-4 items-center justify-center text-xs"
                          style={{ color: `hsl(${profile.accent})` }}
                        >
                          {profile.icon}
                        </span>
                        <span className="flex-1 truncate">{profile.name}</span>
                        {profile.isDefault ? <Meta>default</Meta> : null}
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}

                {recent.length > 0 ? (
                  <Command.Group heading="Recent">
                    {recent.map((c) => (
                      <Item
                        key={c.id}
                        value={`recent ${c.title}`}
                        onSelect={() => go(`/chat/${c.id}`)}
                      >
                        <MessageSquare className="size-4 text-muted-foreground" />
                        <span className="flex-1 truncate">{c.title}</span>
                        <Meta>{formatRelative(c.lastMessageAt)}</Meta>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}

                {projects.length > 0 ? (
                  <Command.Group heading="Projects">
                    {projects.slice(0, 5).map((project) => (
                      <Item
                        key={project.id}
                        value={`project ${project.name}`}
                        onSelect={() => go(`/projects/${project.id}`)}
                      >
                        <span
                          className="flex size-4 items-center justify-center text-xs"
                          style={{ color: `hsl(${project.accent})` }}
                        >
                          {project.icon}
                        </span>
                        <span className="flex-1 truncate">{project.name}</span>
                        <Meta>{project.conversationCount}</Meta>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}

                <Command.Group heading="Go to">
                  {[
                    { href: '/chat', label: 'Chat', icon: Sparkles },
                    { href: '/projects', label: 'Projects', icon: FolderOpen },
                    { href: '/memory', label: 'Memory', icon: Brain },
                    { href: '/dashboard', label: 'Dashboard', icon: BarChart3 },
                    { href: '/models', label: 'Models', icon: Boxes },
                    { href: '/profiles', label: 'Personas', icon: User },
                    { href: '/settings', label: 'Settings', icon: Settings },
                  ].map((item) => (
                    <Item key={item.href} onSelect={() => go(item.href)}>
                      <item.icon className="size-4 text-muted-foreground" />
                      {item.label}
                    </Item>
                  ))}
                </Command.Group>
              </>
            ) : null}
          </Command.List>

          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" /> to select
            </span>
            <span>↑↓ to navigate · esc to close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </Command.Item>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 font-mono text-2xs text-muted-foreground">{children}</span>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

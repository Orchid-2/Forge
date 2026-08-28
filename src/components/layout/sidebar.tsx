'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  BarChart3,
  Boxes,
  Brain,
  ChevronDown,
  Command,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { cn, isMac, timeBucket } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useChatStore } from '@/store/chat-store';

const NAV_ITEMS = [
  { href: '/chat', label: 'Chat', icon: Sparkles },
  { href: '/projects', label: 'Projects', icon: FolderOpen },
  { href: '/memory', label: 'Memory', icon: Brain },
  { href: '/dashboard', label: 'Dashboard', icon: BarChart3 },
  { href: '/models', label: 'Models', icon: Boxes },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const projects = useAppStore((s) => s.projects);

  const conversations = useChatStore((s) => s.conversations);
  const conversationsLoaded = useChatStore((s) => s.conversationsLoaded);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const activeId = useChatStore((s) => s.activeId);

  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);

  useEffect(() => {
    if (!conversationsLoaded) void loadConversations();
  }, [conversationsLoaded, loadConversations]);

  /** Pinned first, then grouped into date buckets in recency order. */
  const grouped = useMemo(() => {
    const pinned = conversations.filter((c) => c.pinned);
    const rest = conversations.filter((c) => !c.pinned);

    const buckets = new Map<string, typeof rest>();
    for (const conversation of rest) {
      const bucket = timeBucket(conversation.lastMessageAt);
      const list = buckets.get(bucket) ?? [];
      list.push(conversation);
      buckets.set(bucket, list);
    }

    return { pinned, buckets: [...buckets.entries()] };
  }, [conversations]);

  if (collapsed) {
    return (
      <aside className="flex h-dvh w-[3.75rem] shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-3">
        <Tooltip label="Expand sidebar" kbd={mac ? '⌘\\' : 'Ctrl \\'} side="right">
          <Button variant="ghost" size="icon-sm" onClick={toggleSidebar} className="mb-1">
            <PanelLeftOpen />
          </Button>
        </Tooltip>

        <Tooltip label="New chat" kbd={mac ? '⌘N' : 'Ctrl N'} side="right">
          <Button
            size="icon-sm"
            onClick={() => router.push('/chat')}
            className="mb-2"
            aria-label="New chat"
          >
            <MessageSquarePlus />
          </Button>
        </Tooltip>

        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Tooltip key={item.href} label={item.label} side="right">
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                className={cn(active && 'bg-accent text-foreground')}
              >
                <Link href={item.href} aria-label={item.label}>
                  <item.icon />
                </Link>
              </Button>
            </Tooltip>
          );
        })}

        <div className="mt-auto">
          <Tooltip label="Settings" side="right">
            <Button asChild variant="ghost" size="icon-sm">
              <Link href="/settings" aria-label="Settings">
                <Settings />
              </Link>
            </Button>
          </Tooltip>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-dvh w-[16.5rem] shrink-0 flex-col border-r border-border bg-chrome">
      {/* Brand + collapse */}
      <div className="flex items-center justify-between px-3 py-3">
        <Link href="/chat" className="group flex items-center gap-2 rounded-md px-1 py-0.5">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground shadow-ember">
            F
          </span>
          <span className="text-[0.9375rem] font-semibold tracking-tight">Forge</span>
        </Link>

        <Tooltip label="Collapse sidebar" kbd={mac ? '⌘\\' : 'Ctrl \\'} side="bottom">
          <Button variant="ghost" size="icon-xs" onClick={toggleSidebar}>
            <PanelLeftClose />
          </Button>
        </Tooltip>
      </div>

      {/* Primary actions */}
      <div className="space-y-1.5 px-3 pb-2">
        <Button className="w-full justify-start gap-2" onClick={() => router.push('/chat')}>
          <MessageSquarePlus />
          New chat
        </Button>

        <button
          onClick={() => setCommandOpen(true)}
          className="flex w-full items-center gap-2 rounded-md border border-border/70 bg-elevated/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-elevated"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="flex items-center gap-0.5 font-mono text-[10px] opacity-70">
            {mac ? <Command className="size-2.5" /> : 'Ctrl '}K
          </kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav className="space-y-0.5 px-3 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-chrome-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
              {item.href === '/projects' && projects.length > 0 ? (
                <span className="ml-auto font-mono text-2xs text-muted-foreground">
                  {projects.length}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* Conversation list */}
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!conversationsLoaded ? (
          <div className="space-y-1.5 px-1 py-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="shimmer h-7 rounded-md" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            No conversations yet.
            <br />
            Start one above.
          </p>
        ) : (
          <>
            {grouped.pinned.length > 0 ? (
              <ConversationGroup
                label="Pinned"
                conversations={grouped.pinned}
                activeId={activeId}
              />
            ) : null}

            {grouped.buckets.map(([bucket, list]) => (
              <ConversationGroup
                key={bucket}
                label={bucket}
                conversations={list}
                activeId={activeId}
              />
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2">
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
            pathname.startsWith('/settings')
              ? 'bg-accent font-medium text-foreground'
              : 'text-chrome-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          <Settings className="size-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}

function ConversationGroup({
  label,
  conversations,
  activeId,
}: {
  label: string;
  conversations: Array<{
    id: string;
    title: string;
    pinned: boolean;
    lastMessageAt: number;
    messageCount: number;
  }>;
  activeId: string | null;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-1 px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={cn('size-3 transition-transform duration-200', !open && '-rotate-90')}
        />
        {label}
        <span className="ml-auto font-mono opacity-0 transition-opacity group-hover:opacity-60">
          {conversations.length}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-px">
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
}: {
  conversation: { id: string; title: string; pinned: boolean; lastMessageAt: number };
  active: boolean;
}) {
  const router = useRouter();
  const updateConversation = useChatStore((s) => s.updateConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);

  const commitRename = async () => {
    setRenaming(false);
    const title = draft.trim();
    if (!title || title === conversation.title) {
      setDraft(conversation.title);
      return;
    }
    await updateConversation(conversation.id, { title });
  };

  if (renaming) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitRename();
          if (e.key === 'Escape') {
            setDraft(conversation.title);
            setRenaming(false);
          }
        }}
        className="w-full rounded-md border border-primary/50 bg-elevated px-2.5 py-1.5 text-sm outline-none ring-2 ring-ring/20"
      />
    );
  }

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        className="min-w-0 flex-1 truncate px-2.5 py-1.5 text-sm"
        title={conversation.title}
      >
        {conversation.pinned ? (
          <Pin className="mr-1.5 inline size-3 shrink-0 -translate-y-px text-primary" />
        ) : null}
        <span className={cn(active ? 'text-foreground' : 'text-chrome-foreground')}>
          {conversation.title}
        </span>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'mr-1 rounded p-1 text-muted-foreground transition-opacity hover:bg-background/60 hover:text-foreground',
              'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100',
            )}
            aria-label="Conversation options"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            Rename
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() =>
              void updateConversation(conversation.id, { pinned: !conversation.pinned })
            }
          >
            {conversation.pinned ? <PinOff /> : <Pin />}
            {conversation.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => {
              void updateConversation(conversation.id, { archived: true });
              toast.success('Archived', {
                description: 'Its substance was saved to memory.',
              });
            }}
          >
            <Archive />
            Archive
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            destructive
            onSelect={() => {
              void deleteConversation(conversation.id);
              if (active) router.push('/chat');
              toast.success('Conversation deleted');
            }}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

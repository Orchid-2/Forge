'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowDown, Brain, Pin, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessageSkeleton } from '@/components/ui/skeleton';
import type { Message } from '@/db/schema';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useChatStore } from '@/store/chat-store';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { ModelSwitcher, PersonaSwitcher } from './switchers';
import { EmptyChat } from './empty-chat';

/**
 * The chat surface.
 *
 * Handles both an existing conversation (`conversationId` set) and the "new
 * chat" state, where the conversation is created by the first send. Keeping
 * both here means the composer, switchers and scroll behaviour have exactly one
 * implementation.
 */
export function ChatView({
  conversationId,
  projectId,
}: {
  conversationId?: string;
  projectId?: string | null;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const defaultProfile = useAppStore((s) => s.defaultProfile);
  const settings = useAppStore((s) => s.settings);
  const providers = useAppStore((s) => s.providers);
  const findProject = useAppStore((s) => s.findProject);

  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const pending = useChatStore((s) => s.pending);
  const loading = useChatStore((s) => s.loadingConversation);
  const conversations = useChatStore((s) => s.conversations);
  const openConversation = useChatStore((s) => s.openConversation);
  const clearActive = useChatStore((s) => s.clearActive);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const editMessage = useChatStore((s) => s.editMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const togglePin = useChatStore((s) => s.togglePin);
  const switchVersion = useChatStore((s) => s.switchVersion);
  const updateConversation = useChatStore((s) => s.updateConversation);

  const conversation = conversations.find((c) => c.id === conversationId);
  const project = findProject(conversation?.projectId ?? projectId);

  /** Draft selections for a chat that does not exist yet. */
  const [draftProfileId, setDraftProfileId] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<{ provider: string; name: string } | null>(null);

  const activeProfileId = conversation?.profileId ?? draftProfileId ?? defaultProfile()?.id ?? null;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeModel = conversation?.model ?? draftModel?.name ?? settings.defaultModel;

  useEffect(() => {
    if (conversationId) void openConversation(conversationId);
    else clearActive();
  }, [conversationId, openConversation, clearActive]);

  /* ── Scroll management ─────────────────────────────────────────────────── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 80px of slack: a user reading the last paragraph is still "at the bottom",
    // and should keep getting auto-scrolled.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distance < 80);
  }, []);

  // Follow the stream only while the user has not scrolled away. `useLayoutEffect`
  // runs before paint, so the view never visibly jumps.
  useLayoutEffect(() => {
    if (pinnedToBottom) scrollToBottom(streaming ? 'auto' : 'smooth');
  }, [messages.length, streaming?.content, streaming?.toolCalls.length, pinnedToBottom, scrollToBottom, streaming]);

  // Jump to the bottom instantly when a conversation opens.
  useLayoutEffect(() => {
    if (!loading && conversationId) {
      scrollToBottom('auto');
      setPinnedToBottom(true);
    }
  }, [loading, conversationId, scrollToBottom]);

  /* ── Escape stops generation ───────────────────────────────────────────── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (streaming || pending)) stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [streaming, pending, stop]);

  const busy = Boolean(streaming && !streaming.error) || pending;

  const handleSend = useCallback(
    (content: string) => {
      void send({
        content,
        conversationId,
        projectId: conversation?.projectId ?? projectId ?? null,
        profileId: activeProfileId,
        provider: draftModel?.provider ?? null,
        model: draftModel?.name ?? null,
        onConversation: (id) => {
          // Swap the URL without a navigation, so the streaming response is not
          // interrupted by a remount.
          window.history.replaceState(null, '', `/chat/${id}`);
          void useChatStore.getState().loadConversations();
        },
      });
    },
    [send, conversationId, conversation?.projectId, projectId, activeProfileId, draftModel],
  );

  const anyBackendOnline = providers.length === 0 || providers.some((p) => p.online);
  const noModel = !activeModel;

  /** The streaming turn is appended as a synthetic row when it is not yet persisted. */
  const rendered = useMemo(() => {
    if (!streaming || streaming.messageId === 'error') return messages;
    if (messages.some((m) => m.id === streaming.messageId)) return messages;

    const placeholder: Message = {
      id: streaming.messageId,
      conversationId: streaming.conversationId,
      seq: messages.length,
      role: 'assistant',
      content: '',
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      toolName: null,
      citedMemoryIds: null,
      provider: (streaming.provider ?? null) as Message['provider'],
      model: streaming.model ?? null,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      pinned: false,
      error: null,
      versionCount: 1,
      activeVersion: 0,
      createdAt: streaming.startedAt,
      updatedAt: streaming.startedAt,
    };
    return [...messages, placeholder];
  }, [messages, streaming]);

  const pinnedMessages = messages.filter((m) => m.pinned);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {project ? (
            <>
              <Link
                href={`/projects/${project.id}`}
                className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span style={{ color: `hsl(${project.accent})` }}>{project.icon}</span>
                {project.name}
              </Link>
              <span className="text-muted-foreground/40">/</span>
            </>
          ) : null}

          <h1 className="min-w-0 truncate text-sm font-medium">
            {conversation?.title ?? 'New chat'}
          </h1>

          {conversation?.summary ? (
            <Badge variant="muted" title="Older turns have been compressed into a summary">
              compressed
            </Badge>
          ) : null}
        </div>

        {pinnedMessages.length > 0 ? (
          <Badge variant="outline" className="gap-1">
            <Pin className="size-2.5" />
            {pinnedMessages.length}
          </Badge>
        ) : null}

        {conversation ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              void updateConversation(conversation.id, { pinned: !conversation.pinned });
            }}
            aria-label={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
          >
            <Pin className={cn('size-3.5', conversation.pinned && 'text-primary')} />
          </Button>
        ) : null}
      </header>

      {/* Warnings */}
      {!anyBackendOnline ? (
        <Banner
          icon={<TriangleAlert className="size-4" />}
          tone="warning"
          action={
            <Button asChild size="xs" variant="secondary">
              <Link href="/settings">Configure</Link>
            </Button>
          }
        >
          No model backend is reachable. Start Ollama with <Code>ollama serve</Code>, or point Forge
          at a running server in Settings.
        </Banner>
      ) : noModel ? (
        <Banner
          icon={<Sparkles className="size-4" />}
          tone="warning"
          action={
            <Button asChild size="xs" variant="secondary">
              <Link href="/models">Get a model</Link>
            </Button>
          }
        >
          No model selected yet. Pull one to start chatting.
        </Banner>
      ) : null}

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4">
          {loading ? (
            <MessageSkeleton />
          ) : rendered.length === 0 ? (
            <EmptyChat
              profile={activeProfile}
              project={project}
              onPrompt={handleSend}
              disabled={busy || noModel}
            />
          ) : (
            <div className="py-4">
              {rendered.map((message) => {
                const isStreamingThis = streaming?.messageId === message.id;
                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isStreaming={isStreamingThis}
                    streamingContent={isStreamingThis ? streaming?.content : undefined}
                    streamingReasoning={isStreamingThis ? streaming?.reasoning : undefined}
                    streamingToolCalls={isStreamingThis ? streaming?.toolCalls : undefined}
                    streamingMemories={isStreamingThis ? streaming?.memories : undefined}
                    showStats={settings.showTokenStats}
                    personaName={activeProfile?.name}
                    personaIcon={activeProfile?.icon}
                    personaAccent={activeProfile?.accent}
                    onEdit={(id, content) => void editMessage(id, content)}
                    onRegenerate={(id) => void regenerate(id)}
                    onDelete={(id, cascade) => {
                      void deleteMessage(id, cascade);
                      toast.success('Message deleted');
                    }}
                    onTogglePin={(id) => void togglePin(id)}
                    onSwitchVersion={(id, version) => void switchVersion(id, version)}
                  />
                );
              })}

              {streaming?.error ? (
                <div className="my-3 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3.5 py-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-destructive">{streaming.error}</p>
                    {streaming.hint ? (
                      <p className="mt-1 text-xs text-muted-foreground">{streaming.hint}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* Bottom spacer so the last turn is not flush against the composer. */}
              <div className="h-8" />
            </div>
          )}
        </div>
      </div>

      {/* Jump-to-bottom */}
      {!pinnedToBottom && rendered.length > 0 ? (
        <div className="pointer-events-none relative">
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={() => {
              scrollToBottom();
              setPinnedToBottom(true);
            }}
            className="pointer-events-auto absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-float"
            aria-label="Jump to latest"
          >
            <ArrowDown />
          </Button>
        </div>
      ) : null}

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-background">
        <Composer
          onSend={handleSend}
          onStop={stop}
          busy={busy}
          disabled={noModel && !anyBackendOnline}
          placeholder={
            activeProfile ? `Message ${activeProfile.name}…` : 'Send a message…'
          }
        >
          <PersonaSwitcher
            value={activeProfileId}
            onChange={(profileId) => {
              if (conversation) void updateConversation(conversation.id, { profileId });
              else setDraftProfileId(profileId);
            }}
          />
          <span className="text-muted-foreground/30">·</span>
          <ModelSwitcher
            value={activeModel}
            onChange={(model) => {
              if (conversation) {
                void updateConversation(conversation.id, {
                  model: model.name,
                  provider: model.provider as never,
                });
              } else {
                setDraftModel(model);
              }
            }}
          />
          {activeProfile?.enabledTools?.length ? (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                <Brain className="size-3" />
                {activeProfile.enabledTools.length} tools
              </span>
            </>
          ) : null}
        </Composer>
      </div>
    </div>
  );
}

function Banner({
  icon,
  tone,
  action,
  children,
}: {
  icon: React.ReactNode;
  tone: 'warning' | 'error';
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2.5 border-b px-4 py-2 text-xs',
        tone === 'warning'
          ? 'border-warning/25 bg-warning/[0.06] text-warning'
          : 'border-destructive/25 bg-destructive/[0.06] text-destructive',
      )}
    >
      {icon}
      <span className="flex-1 text-foreground/80">{children}</span>
      {action}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-border/60 bg-muted px-1 py-px font-mono text-[0.9em]">
      {children}
    </code>
  );
}

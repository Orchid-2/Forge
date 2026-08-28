'use client';

/**
 * Conversation and streaming state.
 *
 * Streaming is the performance-critical path in this app: a fast local model
 * emits hundreds of deltas per second, and a naive implementation re-renders
 * the whole transcript on each one. Two things prevent that here:
 *
 *  1. Deltas accumulate into a buffer and flush on `requestAnimationFrame`, so
 *     React re-renders once per frame instead of once per token.
 *  2. Only the streaming message's own fields change, so `MessageItem` can be
 *     memoised and every settled turn stays untouched.
 */
import { create } from 'zustand';

import type { Conversation, Message, MessageVersion } from '@/db/schema';
import { decodeEventStream, type CitedMemory, type StreamedToolCall } from '@/lib/chat/protocol';
import { api } from '@/lib/client/api';

/** Live state of the turn currently being generated. */
export interface StreamingState {
  messageId: string;
  conversationId: string;
  content: string;
  reasoning: string;
  toolCalls: StreamedToolCall[];
  memories: CitedMemory[];
  model?: string;
  provider?: string;
  startedAt: number;
  /** Set when the backend reported a failure mid-turn. */
  error?: string;
  hint?: string;
}

interface ChatState {
  conversations: Conversation[];
  conversationsLoaded: boolean;

  activeId: string | null;
  messages: Message[];
  versions: MessageVersion[];
  loadingConversation: boolean;

  streaming: StreamingState | null;
  /** Set while a request is in flight but before the first token lands. */
  pending: boolean;

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  clearActive: () => void;

  send: (input: {
    content?: string;
    conversationId?: string;
    projectId?: string | null;
    profileId?: string | null;
    provider?: string | null;
    model?: string | null;
    regenerateMessageId?: string;
    editMessageId?: string;
    /** Called with the conversation id once the server has one. */
    onConversation?: (id: string) => void;
  }) => Promise<void>;

  stop: () => void;

  editMessage: (id: string, content: string) => Promise<void>;
  regenerate: (messageId: string) => Promise<void>;
  deleteMessage: (id: string, cascade?: boolean) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  switchVersion: (id: string, version: number) => Promise<void>;

  updateConversation: (id: string, patch: Partial<Conversation>) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  upsertConversation: (conversation: Conversation) => void;
}

/** Abort handle for the in-flight request, kept outside the store. */
let activeController: AbortController | null = null;

/**
 * Frame-batched delta buffer.
 *
 * Held in module scope rather than in the store: it is a rendering detail, and
 * putting it in state would itself trigger the re-renders it exists to avoid.
 */
let textBuffer = '';
let reasoningBuffer = '';
let flushHandle: number | null = null;

function scheduleFlush(apply: () => void) {
  if (flushHandle !== null) return;
  flushHandle = requestAnimationFrame(() => {
    flushHandle = null;
    apply();
  });
}

function cancelFlush() {
  if (flushHandle !== null) {
    cancelAnimationFrame(flushHandle);
    flushHandle = null;
  }
  textBuffer = '';
  reasoningBuffer = '';
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  conversationsLoaded: false,
  activeId: null,
  messages: [],
  versions: [],
  loadingConversation: false,
  streaming: null,
  pending: false,

  async loadConversations() {
    try {
      const { conversations } = await api.listConversations();
      set({ conversations, conversationsLoaded: true });
    } catch {
      set({ conversationsLoaded: true });
    }
  },

  async openConversation(id) {
    if (get().activeId === id && get().messages.length > 0) return;

    set({ loadingConversation: true, activeId: id });
    try {
      const { conversation, messages, versions } = await api.getConversation(id);
      // Guard against a slow load resolving after the user moved on.
      if (get().activeId !== id) return;

      set({ messages, versions, loadingConversation: false });
      get().upsertConversation(conversation);
    } catch {
      set({ loadingConversation: false, messages: [], versions: [] });
    }
  },

  clearActive() {
    set({ activeId: null, messages: [], versions: [], streaming: null, pending: false });
  },

  async send(input) {
    // One generation at a time: a second would interleave into the same
    // transcript and corrupt the ordering.
    if (get().pending || get().streaming) return;

    activeController = new AbortController();
    set({ pending: true });
    cancelFlush();

    // Show the user's message immediately — waiting for the round trip makes
    // the app feel sluggish even when the model responds fast.
    if (input.content?.trim() && !input.editMessageId) {
      const optimistic: Message = {
        id: `pending_${Date.now()}`,
        conversationId: input.conversationId ?? 'pending',
        seq: get().messages.length,
        role: 'user',
        content: input.content,
        reasoning: null,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        citedMemoryIds: null,
        provider: null,
        model: null,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        pinned: false,
        error: null,
        versionCount: 1,
        activeVersion: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({ messages: [...get().messages, optimistic] });
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: input.conversationId,
          content: input.content,
          projectId: input.projectId,
          profileId: input.profileId,
          provider: input.provider,
          model: input.model,
          regenerateMessageId: input.regenerateMessageId,
          editMessageId: input.editMessageId,
        }),
        signal: activeController.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({ error: 'Request failed.' }));
        set({
          pending: false,
          streaming: {
            messageId: 'error',
            conversationId: input.conversationId ?? '',
            content: '',
            reasoning: '',
            toolCalls: [],
            memories: [],
            startedAt: Date.now(),
            error: detail.error ?? 'Request failed.',
            hint: detail.hint,
          },
        });
        return;
      }

      // The server may have created the conversation for us.
      const conversationId = response.headers.get('X-Conversation-Id') ?? input.conversationId;
      if (conversationId && conversationId !== input.conversationId) {
        input.onConversation?.(conversationId);
        set({ activeId: conversationId });
      }

      for await (const event of decodeEventStream(response.body)) {
        switch (event.t) {
          case 'start': {
            set({
              pending: false,
              streaming: {
                messageId: event.messageId,
                conversationId: event.conversationId,
                content: '',
                reasoning: '',
                toolCalls: [],
                memories: [],
                model: event.model,
                provider: event.provider,
                startedAt: Date.now(),
              },
            });
            break;
          }

          case 'memories': {
            const current = get().streaming;
            if (current) set({ streaming: { ...current, memories: event.items } });
            break;
          }

          case 'text': {
            textBuffer += event.d;
            scheduleFlush(() => {
              const current = get().streaming;
              if (!current || !textBuffer) return;
              set({ streaming: { ...current, content: current.content + textBuffer } });
              textBuffer = '';
            });
            break;
          }

          case 'reasoning': {
            reasoningBuffer += event.d;
            scheduleFlush(() => {
              const current = get().streaming;
              if (!current || !reasoningBuffer) return;
              set({ streaming: { ...current, reasoning: current.reasoning + reasoningBuffer } });
              reasoningBuffer = '';
            });
            break;
          }

          case 'tool': {
            const current = get().streaming;
            if (!current) break;
            // The same call arrives twice — running, then done — so replace by
            // id rather than appending.
            const existing = current.toolCalls.findIndex((c) => c.id === event.call.id);
            const toolCalls =
              existing === -1
                ? [...current.toolCalls, event.call]
                : current.toolCalls.map((c, i) => (i === existing ? event.call : c));
            set({ streaming: { ...current, toolCalls } });
            break;
          }

          case 'title': {
            const id = get().activeId;
            if (id) {
              set({
                conversations: get().conversations.map((c) =>
                  c.id === id ? { ...c, title: event.title, titleGenerated: true } : c,
                ),
              });
            }
            break;
          }

          case 'error': {
            const current = get().streaming;
            set({
              pending: false,
              streaming: current
                ? { ...current, error: event.message, hint: event.hint }
                : {
                    messageId: 'error',
                    conversationId: conversationId ?? '',
                    content: '',
                    reasoning: '',
                    toolCalls: [],
                    memories: [],
                    startedAt: Date.now(),
                    error: event.message,
                    hint: event.hint,
                  },
            });
            break;
          }

          case 'done':
          case 'usage':
            break;
        }
      }
    } catch (error) {
      // An abort is the user pressing stop, not a failure.
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted) {
        const current = get().streaming;
        const message = error instanceof Error ? error.message : 'Connection lost.';
        set({
          streaming: current
            ? { ...current, error: message }
            : {
                messageId: 'error',
                conversationId: input.conversationId ?? '',
                content: '',
                reasoning: '',
                toolCalls: [],
                memories: [],
                startedAt: Date.now(),
                error: message,
              },
        });
      }
    } finally {
      activeController = null;

      // Flush anything still buffered, then reload the canonical transcript so
      // the UI shows exactly what was persisted — ids, token counts and all.
      cancelFlush();
      set({ pending: false });

      const id = get().activeId;
      const hadError = Boolean(get().streaming?.error);

      if (id) {
        try {
          const { conversation, messages, versions } = await api.getConversation(id);
          if (get().activeId === id) {
            set({ messages, versions, streaming: null });
            get().upsertConversation(conversation);
          }
        } catch {
          // Keep the streamed text on screen if the reload fails; losing the
          // reply the user just watched arrive would be far worse.
          if (!hadError) set({ streaming: null });
        }
      } else if (!hadError) {
        set({ streaming: null });
      }
    }
  },

  stop() {
    activeController?.abort();
    activeController = null;
    cancelFlush();
    set({ pending: false });
  },

  async editMessage(id, content) {
    const target = get().messages.find((m) => m.id === id);
    if (!target) return;

    if (target.role === 'user') {
      // Editing a question re-runs everything that followed from it.
      await get().send({
        conversationId: get().activeId ?? undefined,
        content,
        editMessageId: id,
      });
      return;
    }

    // Editing an assistant turn is a plain text correction.
    const { message } = await api.updateMessage(id, { content });
    set({ messages: get().messages.map((m) => (m.id === id ? message : m)) });
  },

  async regenerate(messageId) {
    await get().send({
      conversationId: get().activeId ?? undefined,
      regenerateMessageId: messageId,
    });
  },

  async deleteMessage(id, cascade = false) {
    const { messages } = await api.deleteMessage(id, cascade);
    set({ messages });
  },

  async togglePin(id) {
    const target = get().messages.find((m) => m.id === id);
    if (!target) return;

    // Optimistic — pinning should feel instantaneous.
    set({
      messages: get().messages.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m)),
    });

    try {
      await api.updateMessage(id, { pinned: !target.pinned });
    } catch {
      set({
        messages: get().messages.map((m) => (m.id === id ? { ...m, pinned: target.pinned } : m)),
      });
    }
  },

  async switchVersion(id, version) {
    const { message } = await api.updateMessage(id, { activeVersion: version });
    set({ messages: get().messages.map((m) => (m.id === id ? message : m)) });
  },

  async updateConversation(id, patch) {
    set({
      conversations: get().conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
    try {
      const { conversation } = await api.updateConversation(id, patch);
      get().upsertConversation(conversation);
    } catch {
      void get().loadConversations();
    }
  },

  async deleteConversation(id) {
    set({ conversations: get().conversations.filter((c) => c.id !== id) });
    if (get().activeId === id) get().clearActive();
    try {
      await api.deleteConversation(id);
    } catch {
      void get().loadConversations();
    }
  },

  upsertConversation(conversation) {
    const existing = get().conversations;
    const index = existing.findIndex((c) => c.id === conversation.id);
    set({
      conversations:
        index === -1
          ? [conversation, ...existing]
          : existing.map((c, i) => (i === index ? conversation : c)),
    });
  },
}));

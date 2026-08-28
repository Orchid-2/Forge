/**
 * The chat pipeline: one turn, start to finish.
 *
 * Yields `ChatStreamEvent`s that the API route forwards to the browser, while
 * persisting the transcript as it goes. Everything that is not needed to render
 * the reply — titling, memory extraction, summarisation, vault sync — is
 * deferred to `runBackgroundJobs` so nothing delays the tokens on screen.
 */
import 'server-only';

import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  activity,
  conversations,
  messages,
  messageVersions,
  models,
  profiles,
  projects,
  type Conversation,
  type Profile,
  type StoredToolCall,
} from '@/db/schema';
import { createId } from '@/lib/ids';
import {
  buildToolInstructions,
  estimateTokens,
  getProvider,
  likelySupportsNativeTools,
  PromptedToolParser,
  resolveModel,
  type ChatMessage,
  type ToolCall,
} from '@/lib/llm';
import { ProviderError } from '@/lib/llm/types';
import { extractMemories, summarizeIfNeeded, generateTitle } from '@/lib/memory';
import { getSettings } from '@/lib/settings';
import { executeTool, toolsForProfile, toSpec } from '@/lib/tools/registry';
import { buildPrompt, loadPromptContext } from './prompt';
import type { ChatStreamEvent, StreamedToolCall } from './protocol';

export interface TurnOptions {
  conversationId: string;
  /** New user message. Omitted when regenerating an existing reply. */
  userContent?: string;
  /** Regenerate this assistant message, keeping its earlier take as a version. */
  regenerateMessageId?: string;
  /** Rewrite this user message, then discard and regenerate everything after. */
  editMessageId?: string;
  signal?: AbortSignal;
}

/**
 * Runs one turn.
 *
 * Written as an async generator so the route can stream and so cancellation is
 * a plain `break` — no callback plumbing, no manual subscription teardown.
 */
export async function* runTurn(options: TurnOptions): AsyncGenerator<ChatStreamEvent> {
  const db = getDb();
  const settings = getSettings();
  const startedAt = Date.now();

  const context = loadPromptContext(options.conversationId);
  if (!context) {
    yield { t: 'error', message: 'Conversation not found.' };
    return;
  }

  let { conversation } = context;
  const { profile, project } = context;

  /* ── Apply the edit / regenerate intent before building the prompt ─────── */
  if (options.editMessageId) {
    applyEdit(options.editMessageId, options.userContent ?? '', conversation.id);
  } else if (options.regenerateMessageId) {
    prepareRegenerate(options.regenerateMessageId);
  } else if (options.userContent?.trim()) {
    appendUserMessage(conversation.id, options.userContent.trim());
  }

  // Reload: the writes above changed the history the prompt is built from.
  const refreshed = loadPromptContext(options.conversationId);
  if (!refreshed) {
    yield { t: 'error', message: 'Conversation disappeared mid-turn.' };
    return;
  }
  conversation = refreshed.conversation;

  const resolved = resolveModel({ conversation, project, profile });
  if (!resolved.model) {
    yield {
      t: 'error',
      message: 'No model selected.',
      hint: 'Pick one in the model switcher, or set a default in Settings → Backends.',
    };
    return;
  }

  /* ── Decide how tools will be offered to this model ────────────────────── */
  const tools = settings.toolsEnabled ? toolsForProfile(profile?.enabledTools) : [];
  const provider = getProvider(resolved.provider);
  const useNativeTools =
    tools.length > 0 && provider.supportsNativeTools && likelySupportsNativeTools(resolved.model);
  const toolInstructions =
    tools.length > 0 && !useNativeTools ? buildToolInstructions(tools.map(toSpec)) : undefined;

  const lastUser = [...refreshed.history].reverse().find((m) => m.role === 'user');

  const prompt = await buildPrompt(refreshed, {
    queryText: lastUser?.content ?? options.userContent ?? '',
    contextWindow: profile?.contextWindow ?? undefined,
    toolInstructions,
  });

  /* ── Create the assistant row we are about to stream into ──────────────── */
  const assistantId = options.regenerateMessageId ?? createId('msg');

  if (!options.regenerateMessageId) {
    db.insert(messages)
      .values({
        id: assistantId,
        conversationId: conversation.id,
        seq: nextSeq(conversation.id),
        role: 'assistant',
        content: '',
        provider: resolved.provider,
        model: resolved.model,
        citedMemoryIds: prompt.citedMemories.map((m) => m.id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  }

  yield {
    t: 'start',
    messageId: assistantId,
    conversationId: conversation.id,
    model: resolved.model,
    provider: resolved.provider,
  };

  if (prompt.citedMemories.length > 0) {
    yield { t: 'memories', items: prompt.citedMemories };
  }

  /* ── Generation loop: generate → run tools → generate again ────────────── */
  const working: ChatMessage[] = [...prompt.messages];
  const toolSpecs = tools.map(toSpec);
  const executedCalls: StoredToolCall[] = [];

  let answer = '';
  let reasoning = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let iterations = 0;

  try {
    while (iterations <= settings.maxToolIterations) {
      iterations++;

      const pendingCalls: ToolCall[] = [];
      const parser = toolInstructions ? new PromptedToolParser() : null;
      let iterationText = '';

      for await (const event of provider.chat({
        model: resolved.model,
        messages: working,
        tools: useNativeTools ? toolSpecs : undefined,
        options: {
          temperature: profile?.temperature,
          topP: profile?.topP,
          topK: profile?.topK,
          repeatPenalty: profile?.repeatPenalty,
          maxTokens: profile?.maxTokens,
          contextWindow: profile?.contextWindow ?? undefined,
          stop: profile?.stopSequences ?? undefined,
        },
        signal: options.signal,
      })) {
        switch (event.type) {
          case 'text': {
            if (parser) {
              // Fallback mode: the parser decides what is prose and what is a
              // tool call, holding back only partial tags.
              const { text, calls } = parser.push(event.delta);
              if (text) {
                iterationText += text;
                answer += text;
                yield { t: 'text', d: text };
              }
              pendingCalls.push(...calls);
            } else {
              iterationText += event.delta;
              answer += event.delta;
              yield { t: 'text', d: event.delta };
            }
            break;
          }

          case 'reasoning':
            reasoning += event.delta;
            yield { t: 'reasoning', d: event.delta };
            break;

          case 'tool_call':
            pendingCalls.push(event.call);
            break;

          case 'usage':
            promptTokens = event.usage.promptTokens || promptTokens;
            completionTokens += event.usage.completionTokens;
            break;

          case 'error':
            yield { t: 'error', message: event.message };
            finalizeMessage(assistantId, {
              content: answer,
              reasoning,
              toolCalls: executedCalls,
              promptTokens,
              completionTokens,
              durationMs: Date.now() - startedAt,
              error: event.message,
            });
            return;

          case 'done':
            break;
        }
      }

      if (parser) {
        const { text, calls } = parser.finish();
        if (text) {
          iterationText += text;
          answer += text;
          yield { t: 'text', d: text };
        }
        pendingCalls.push(...calls);
      }

      // No tools requested — the turn is complete.
      if (pendingCalls.length === 0) break;

      if (iterations > settings.maxToolIterations) {
        const notice = `\n\n_Stopped after ${settings.maxToolIterations} tool rounds._`;
        answer += notice;
        yield { t: 'text', d: notice };
        break;
      }

      // Record the assistant's request turn before running anything, so the
      // transcript stays valid if a tool hangs and the user aborts.
      working.push({ role: 'assistant', content: iterationText, toolCalls: pendingCalls });

      for (const call of pendingCalls) {
        const streamed: StreamedToolCall = {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'running',
        };
        yield { t: 'tool', call: streamed };

        const result = await executeTool(call.name, call.arguments, {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          profileId: conversation.profileId,
          signal: options.signal,
        });

        const finished: StreamedToolCall = {
          ...streamed,
          status: result.error ? 'error' : 'done',
          result: result.content,
          error: result.error,
          durationMs: result.durationMs,
        };
        yield { t: 'tool', call: finished };

        executedCalls.push({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          result: result.content,
          error: result.error,
          durationMs: result.durationMs,
        });

        working.push({
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          name: call.name,
        });
      }

      // Persist progress between rounds: a crash mid-loop should not lose the
      // tool work already done.
      finalizeMessage(assistantId, {
        content: answer,
        reasoning,
        toolCalls: executedCalls,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === 'AbortError') || options.signal?.aborted;

    // A stop is a normal outcome: keep the partial reply, do not mark an error.
    if (aborted) {
      finalizeMessage(assistantId, {
        content: answer,
        reasoning,
        toolCalls: executedCalls,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startedAt,
      });
      yield { t: 'done', messageId: assistantId };
      return;
    }

    const message = error instanceof Error ? error.message : 'Generation failed.';
    const hint = error instanceof ProviderError ? error.hint : undefined;

    finalizeMessage(assistantId, {
      content: answer,
      reasoning,
      toolCalls: executedCalls,
      promptTokens,
      completionTokens,
      durationMs: Date.now() - startedAt,
      error: message,
    });

    yield { t: 'error', message, hint };
    return;
  }

  /* ── Persist and report ────────────────────────────────────────────────── */
  const durationMs = Date.now() - startedAt;

  // Some backends never report usage; estimate so the UI is not blank.
  if (completionTokens === 0) completionTokens = estimateTokens(answer);
  if (promptTokens === 0) promptTokens = prompt.estimatedTokens;

  finalizeMessage(assistantId, {
    content: answer,
    reasoning,
    toolCalls: executedCalls,
    promptTokens,
    completionTokens,
    durationMs,
  });

  updateConversationCounters(conversation.id, promptTokens + completionTokens);
  touchModel(resolved.provider, resolved.model);

  yield { t: 'usage', promptTokens, completionTokens, durationMs };

  /* ── Auto-title, live, before the stream closes ────────────────────────── */
  if (settings.autoTitle && !conversation.titleGenerated && lastUser) {
    const title = await generateTitle(lastUser.content, answer);
    if (title) {
      db.update(conversations)
        .set({ title, titleGenerated: true, updatedAt: Date.now() })
        .where(eq(conversations.id, conversation.id))
        .run();
      yield { t: 'title', title };
    }
  }

  yield { t: 'done', messageId: assistantId };

  // Deliberately not awaited: these can take tens of seconds on a local model
  // and the user is already reading the reply.
  void runBackgroundJobs({
    conversationId: conversation.id,
    assistantMessageId: assistantId,
    userContent: lastUser?.content ?? '',
    assistantContent: answer,
    profile,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Persistence helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function nextSeq(conversationId: string): number {
  const db = getDb();
  const row = db
    .select({ max: sql<number>`COALESCE(MAX(${messages.seq}), -1)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .get();
  return (row?.max ?? -1) + 1;
}

function appendUserMessage(conversationId: string, content: string): void {
  const db = getDb();
  const now = Date.now();

  db.insert(messages)
    .values({
      id: createId('msg'),
      conversationId,
      seq: nextSeq(conversationId),
      role: 'user',
      content,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.update(conversations)
    .set({ lastMessageAt: now, updatedAt: now, messageCount: sql`${conversations.messageCount} + 1` })
    .where(eq(conversations.id, conversationId))
    .run();
}

/**
 * Rewrites a user message and discards everything after it.
 *
 * Editing a turn invalidates every reply that followed from it, so keeping them
 * would produce a transcript that never happened.
 */
function applyEdit(messageId: string, content: string, conversationId: string): void {
  const db = getDb();
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target) return;

  db.update(messages)
    .set({ content, updatedAt: Date.now() })
    .where(eq(messages.id, messageId))
    .run();

  db.delete(messages)
    .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, target.seq)))
    .run();

  const remaining = db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .get();

  db.update(conversations)
    .set({ messageCount: remaining?.count ?? 0, updatedAt: Date.now() })
    .where(eq(conversations.id, conversationId))
    .run();
}

/**
 * Archives the current text of a message as a version, so regenerating offers
 * a "‹ 1 / 2 ›" pager rather than destroying the previous answer.
 */
function prepareRegenerate(messageId: string): void {
  const db = getDb();
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!target) return;

  if (target.content || target.toolCalls?.length) {
    db.insert(messageVersions)
      .values({
        id: createId('mver'),
        messageId,
        version: target.versionCount - 1,
        content: target.content,
        reasoning: target.reasoning,
        toolCalls: target.toolCalls,
        model: target.model,
        promptTokens: target.promptTokens,
        completionTokens: target.completionTokens,
        createdAt: target.createdAt,
      })
      .run();
  }

  db.update(messages)
    .set({
      content: '',
      reasoning: null,
      toolCalls: null,
      error: null,
      versionCount: target.versionCount + 1,
      activeVersion: target.versionCount,
      updatedAt: Date.now(),
    })
    .where(eq(messages.id, messageId))
    .run();
}

function finalizeMessage(
  messageId: string,
  data: {
    content: string;
    reasoning: string;
    toolCalls: StoredToolCall[];
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    error?: string;
  },
): void {
  getDb()
    .update(messages)
    .set({
      content: data.content,
      reasoning: data.reasoning || null,
      toolCalls: data.toolCalls.length ? data.toolCalls : null,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      durationMs: data.durationMs,
      error: data.error ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(messages.id, messageId))
    .run();
}

function updateConversationCounters(conversationId: string, tokens: number): void {
  const db = getDb();
  const counted = db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .get();

  db.update(conversations)
    .set({
      messageCount: counted?.count ?? 0,
      tokenCount: sql`${conversations.tokenCount} + ${tokens}`,
      lastMessageAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

/** Keeps "recently used" ordering in the model switcher honest. */
function touchModel(provider: string, model: string): void {
  const db = getDb();
  db.update(models)
    .set({ lastUsedAt: Date.now() })
    .where(and(eq(models.provider, provider as never), eq(models.name, model)))
    .run();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Background work
 * ──────────────────────────────────────────────────────────────────────────── */

interface BackgroundJobInput {
  conversationId: string;
  assistantMessageId: string;
  userContent: string;
  assistantContent: string;
  profile: Profile | null;
}

/**
 * Post-turn work: memory extraction, summarisation, integrations.
 *
 * Each step is independently guarded — a failing Obsidian vault must not stop
 * memory extraction, and none of it may ever throw into the request that
 * spawned it.
 */
async function runBackgroundJobs(input: BackgroundJobInput): Promise<void> {
  const settings = getSettings();
  const db = getDb();

  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .get();
  if (!conversation) return;

  if (
    settings.memoryEnabled &&
    settings.memoryAutoExtract &&
    input.profile?.memoryWrite !== false &&
    input.assistantContent.length > 40
  ) {
    try {
      await extractMemories(
        [
          { role: 'user', content: input.userContent },
          { role: 'assistant', content: input.assistantContent },
        ],
        {
          conversationId: conversation.id,
          messageId: input.assistantMessageId,
          projectId: conversation.projectId,
          profileId: conversation.profileId,
        },
      );
    } catch {
      /* extraction is best-effort */
    }
  }

  try {
    await summarizeIfNeeded(conversation.id);
  } catch {
    /* summarisation is best-effort */
  }

  // Integrations are imported lazily so a chat turn never pays to load the
  // Hugging Face or filesystem code paths when they are switched off.
  if (settings.obsidianEnabled && settings.obsidianAutoSync) {
    try {
      const { syncConversationToVault } = await import('@/lib/integrations/obsidian');
      await syncConversationToVault(conversation.id);
    } catch {
      /* vault may be unmounted */
    }
  }

  if (settings.hfAutoSync && settings.hfToken && settings.hfBackupRepo) {
    try {
      const { syncConversationToHub } = await import('@/lib/integrations/huggingface');
      await syncConversationToHub(conversation.id);
    } catch {
      /* offline or rate-limited */
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Conversation creation
 * ──────────────────────────────────────────────────────────────────────────── */

export function createConversation(input: {
  title?: string;
  projectId?: string | null;
  profileId?: string | null;
  provider?: string | null;
  model?: string | null;
}): Conversation {
  const db = getDb();
  const now = Date.now();

  // Inherit from the project when it has defaults and none were passed.
  const project = input.projectId
    ? db.select().from(projects).where(eq(projects.id, input.projectId)).get()
    : null;

  const profileId =
    input.profileId ??
    project?.defaultProfileId ??
    db.select().from(profiles).where(eq(profiles.isDefault, true)).get()?.id ??
    db.select().from(profiles).orderBy(desc(profiles.sortOrder)).get()?.id ??
    null;

  const conversation = db
    .insert(conversations)
    .values({
      id: createId('conv'),
      title: input.title ?? 'New chat',
      projectId: input.projectId ?? null,
      profileId,
      provider: (input.provider ?? project?.defaultProvider ?? null) as never,
      model: input.model ?? project?.defaultModel ?? null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    })
    .returning()
    .get();

  db.insert(activity)
    .values({
      id: createId('act'),
      type: 'conversation.created',
      title: conversation.title,
      entityId: conversation.id,
      createdAt: now,
    })
    .run();

  return conversation;
}

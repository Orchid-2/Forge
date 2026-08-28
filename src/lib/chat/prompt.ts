/**
 * Prompt assembly and context packing.
 *
 * The system prompt is layered, most-general to most-specific:
 *
 *   1. Who the user is        (settings: name + about-me)
 *   2. Persona                (profile.systemPrompt)
 *   3. Project instructions   (project.systemPrompt)
 *   4. Conversation override  (conversation.systemPrompt)
 *   5. Retrieved memories
 *   6. Rolling summary of older turns
 *
 * Ordering matters: later layers win when they conflict, which is what lets a
 * project override a persona and a single conversation override both.
 */
import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  conversations,
  messages,
  profiles,
  projects,
  type Conversation,
  type Message,
  type Profile,
  type Project,
} from '@/db/schema';
import { estimateTokens, type ChatMessage } from '@/lib/llm';
import { markAccessed, retrieveMemories } from '@/lib/memory';
import { getSettings } from '@/lib/settings';
import type { CitedMemory } from './protocol';

/** Fallback context window when neither the model nor the profile declares one. */
const DEFAULT_CONTEXT_WINDOW = 8192;
/** Share of the window reserved for the reply and for estimation error. */
const RESPONSE_HEADROOM = 0.35;

export interface PromptContext {
  conversation: Conversation;
  profile: Profile | null;
  project: Project | null;
  history: Message[];
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  citedMemories: CitedMemory[];
  /** Rough prompt size, for the token meter in the composer. */
  estimatedTokens: number;
  /** Turns dropped to fit the window — surfaced so the UI can say so. */
  droppedMessages: number;
}

export function loadPromptContext(conversationId: string): PromptContext | null {
  const db = getDb();

  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conversation) return null;

  const profile = conversation.profileId
    ? (db.select().from(profiles).where(eq(profiles.id, conversation.profileId)).get() ?? null)
    : (db.select().from(profiles).where(eq(profiles.isDefault, true)).get() ?? null);

  const project = conversation.projectId
    ? (db.select().from(projects).where(eq(projects.id, conversation.projectId)).get() ?? null)
    : null;

  const history = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all();

  return { conversation, profile, project, history };
}

/**
 * Builds the full message array for a generation.
 *
 * `queryText` is what memory retrieval searches against — normally the newest
 * user message.
 */
export async function buildPrompt(
  context: PromptContext,
  options: { queryText: string; contextWindow?: number; toolInstructions?: string } = {
    queryText: '',
  },
): Promise<BuiltPrompt> {
  const settings = getSettings();
  const { conversation, profile, project, history } = context;

  /* ── Layer 1: who the user is ──────────────────────────────────────────── */
  const sections: string[] = [];

  if (settings.userName || settings.userContext) {
    const about = [
      settings.userName ? `The user's name is ${settings.userName}.` : '',
      settings.userContext,
    ]
      .filter(Boolean)
      .join('\n');
    sections.push(`# About the user\n${about}`);
  }

  /* ── Layers 2-4: persona, project, conversation ────────────────────────── */
  if (profile?.systemPrompt) sections.push(profile.systemPrompt);
  if (project?.systemPrompt) sections.push(`# Project: ${project.name}\n${project.systemPrompt}`);
  if (conversation.systemPrompt) sections.push(conversation.systemPrompt);

  /* ── Layer 5: retrieved memories ───────────────────────────────────────── */
  const citedMemories: CitedMemory[] = [];

  if (settings.memoryEnabled && profile?.memoryRead !== false && options.queryText) {
    const retrieved = await retrieveMemories(options.queryText, {
      projectId: conversation.projectId,
      profileId: conversation.profileId,
    });

    const selected = retrieved.slice(0, settings.memoryMaxInjected);

    if (selected.length > 0) {
      // Usage feeds the retrieval prior, so record it here rather than at the
      // call site where it is easy to forget.
      markAccessed(selected.map((s) => s.memory.id));

      const lines = selected
        .map((s) => `- ${s.memory.content}`)
        .join('\n');

      sections.push(
        [
          '# What you remember about the user',
          'These are things you have learned in past conversations. Use them naturally.',
          'Do not announce that you are recalling them, and do not list them back.',
          '',
          lines,
        ].join('\n'),
      );

      for (const s of selected) {
        citedMemories.push({
          id: s.memory.id,
          title: s.memory.title ?? s.memory.content.slice(0, 60),
          content: s.memory.content,
          kind: s.memory.kind,
          score: Number(s.score.toFixed(3)),
        });
      }
    }
  }

  /* ── Layer 6: rolling summary of compressed turns ──────────────────────── */
  if (conversation.summary) {
    sections.push(`# Earlier in this conversation\n${conversation.summary}`);
  }

  /* ── Tool instructions, when running in prompted-tools fallback mode ───── */
  if (options.toolInstructions) sections.push(options.toolInstructions);

  const systemPrompt = sections.filter(Boolean).join('\n\n');

  /* ── Pack the transcript into the remaining context budget ─────────────── */
  const contextWindow =
    options.contextWindow ?? profile?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const systemTokens = estimateTokens(systemPrompt);
  const budget = Math.max(
    contextWindow * (1 - RESPONSE_HEADROOM) - systemTokens,
    // Never pack to zero, even with an oversized system prompt — better to
    // overflow slightly than to send a turn with no conversation in it.
    contextWindow * 0.15,
  );

  const eligible = history.filter(
    (m) =>
      // Turns already folded into the summary are represented by it.
      m.seq >= conversation.summarizedUntil &&
      // A failed generation left an empty row; sending it teaches the model
      // that empty replies are acceptable.
      !(m.role === 'assistant' && !m.content && !m.toolCalls?.length),
  );

  const packed: ChatMessage[] = [];
  let used = 0;
  let dropped = 0;

  // Walk backwards from the newest turn, keeping what fits.
  for (let i = eligible.length - 1; i >= 0; i--) {
    const message = eligible[i];
    const cost = estimateTokens(message.content) + 8;

    if (used + cost > budget && packed.length > 0) {
      dropped = i + 1;
      break;
    }

    packed.unshift(toChatMessage(message));
    used += cost;
  }

  // A tool result whose request got trimmed is invalid to most backends.
  while (packed.length > 0 && packed[0].role === 'tool') {
    packed.shift();
    dropped++;
  }

  const result: ChatMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...packed]
    : packed;

  return {
    messages: result,
    citedMemories,
    estimatedTokens: systemTokens + used,
    droppedMessages: dropped,
  };
}

function toChatMessage(message: Message): ChatMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      toolCallId: message.toolCallId ?? undefined,
      name: message.toolName ?? undefined,
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }

  return { role: message.role as ChatMessage['role'], content: message.content };
}

/**
 * Conversation compression.
 *
 * Long conversations eventually exceed the context window. Rather than silently
 * dropping the oldest turns — which loses the thread — Forge folds them into a
 * rolling summary stored on the conversation, and keeps recent turns verbatim.
 *
 * The summary is regenerated incrementally: each pass summarises the previous
 * summary plus the newly-aged-out turns, so cost stays constant no matter how
 * long the conversation runs.
 */
import 'server-only';

import { asc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { conversations, messages, type Conversation } from '@/db/schema';
import { complete, resolveUtilityModel } from '@/lib/llm';
import { getSettings } from '@/lib/settings';
import { createMemory } from './store';

const SUMMARY_PROMPT = `You maintain a running summary of a long conversation.

Given the existing summary and the new messages that follow it, produce an
updated summary that a model could read to continue the conversation seamlessly.

Preserve, in this order of priority:
1. Decisions made and conclusions reached, with the reasoning behind them.
2. Facts about the user established in the conversation.
3. Open questions and unfinished threads.
4. Constraints, requirements and preferences stated.
5. Names, systems and specifics that later turns refer back to.

Drop: pleasantries, restated context, and anything superseded by a later turn.

Write compact prose under 400 words. No headings, no bullet points, no preamble.
Write it as a briefing to the assistant, not as a report to the user.`;

/**
 * Compresses a conversation if it has grown past the configured threshold.
 * Returns the new summary, or null when no work was needed.
 */
export async function summarizeIfNeeded(conversationId: string): Promise<string | null> {
  const settings = getSettings();
  if (!settings.autoSummarize) return null;

  const db = getDb();
  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conversation) return null;

  const all = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all();

  const keepRecent = settings.summarizeKeepRecent;
  if (all.length < settings.summarizeAfterMessages) return null;

  // Everything before this index is eligible to be folded into the summary.
  const boundary = all.length - keepRecent;
  const pending = all.filter(
    (m) => m.seq >= conversation.summarizedUntil && m.seq < (all[boundary]?.seq ?? 0),
  );

  // Not enough new material since the last pass to be worth a model call.
  if (pending.length < 4) return null;

  const transcript = pending
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 24_000);

  const summary = await complete(
    resolveUtilityModel({ provider: conversation.provider ?? 'ollama', model: conversation.model ?? '' }),
    [
      { role: 'system', content: SUMMARY_PROMPT },
      {
        role: 'user',
        content: conversation.summary
          ? `Existing summary:\n${conversation.summary}\n\nNew messages:\n${transcript}`
          : `Messages:\n${transcript}`,
      },
    ],
    { temperature: 0.3, maxTokens: 768, timeoutMs: 120_000 },
  );

  if (!summary) return null;

  db.update(conversations)
    .set({
      summary,
      summarizedUntil: all[boundary]?.seq ?? conversation.summarizedUntil,
      updatedAt: Date.now(),
    })
    .where(eq(conversations.id, conversationId))
    .run();

  return summary;
}

/**
 * Distils a whole conversation into one durable memory.
 *
 * Called when a conversation is archived, so its substance survives even if the
 * transcript is never opened again.
 */
export async function archiveConversationToMemory(
  conversation: Conversation,
): Promise<string | null> {
  const db = getDb();
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.seq))
    .all();

  if (rows.length < 4) return null;

  const transcript = rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 24_000);

  const summary = await complete(
    resolveUtilityModel(),
    [
      {
        role: 'system',
        content:
          'Summarise this conversation in under 150 words. Capture what was decided, ' +
          'concluded, or learned — not what was discussed. Third person, plain prose.',
      },
      { role: 'user', content: transcript },
    ],
    { temperature: 0.3, maxTokens: 400 },
  );

  if (!summary) return null;

  const { memory } = await createMemory({
    content: `From the conversation "${conversation.title}": ${summary}`,
    title: conversation.title,
    kind: 'summary',
    source: 'summary',
    // Summaries are context, not identity facts — they should not outrank a
    // directly-stated preference during retrieval.
    importance: 0.45,
    confidence: 0.7,
    sourceConversationId: conversation.id,
    projectId: conversation.projectId,
  });

  return memory.id;
}

/**
 * Generates a conversation title from its opening exchange.
 *
 * Small local models love to answer the question instead of titling it, so the
 * prompt is blunt and the output is aggressively sanitised.
 */
export async function generateTitle(firstUserMessage: string, firstReply: string): Promise<string> {
  const raw = await complete(
    resolveUtilityModel(),
    [
      {
        role: 'system',
        content:
          'Write a title for this conversation: 2-5 words, no quotes, no punctuation at the end, ' +
          'Title Case. Describe the topic, do not answer anything. Reply with the title only.',
      },
      {
        role: 'user',
        content: `User: ${firstUserMessage.slice(0, 800)}\n\nAssistant: ${firstReply.slice(0, 400)}`,
      },
    ],
    { temperature: 0.4, maxTokens: 24, timeoutMs: 30_000 },
  );

  const cleaned = raw
    .split('\n')[0]
    .replace(/^["'`\s]+|["'`\s.]+$/g, '')
    .replace(/^(title|conversation)\s*[:\-]\s*/i, '')
    .trim();

  // A "title" that long is the model having answered the question instead.
  if (!cleaned || cleaned.length > 72) return '';
  return cleaned;
}

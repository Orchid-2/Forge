/**
 * Automatic memory extraction.
 *
 * After a turn completes, a small model reads the exchange and proposes durable
 * facts worth remembering. This runs in the background so it never delays the
 * response the user is reading.
 *
 * The hard part is not extraction, it is *restraint*: a naive prompt will
 * happily store "the user asked about Python", which is noise that degrades
 * every future retrieval. The prompt and the post-filter below both exist to
 * keep the store sparse and high-signal.
 */
import 'server-only';

import { complete, resolveUtilityModel, type ResolvedModel } from '@/lib/llm';
import { getSettings } from '@/lib/settings';
import type { MemoryKind } from '@/db/schema';
import { createMemory } from './store';

const EXTRACTION_PROMPT = `You extract durable, long-term memories from a conversation.

Return a JSON array. Each item:
{"content": string, "kind": "fact"|"preference"|"event"|"entity"|"instruction"|"insight", "importance": 0.0-1.0, "tags": string[]}

STORE only things that will still matter weeks from now:
- Stable facts about the user (their work, tools, location, relationships, health, constraints)
- Durable preferences ("prefers terse answers", "uses pnpm not npm", "hates em-dashes")
- Significant events with lasting consequence (started a job, shipped a project, a decision made)
- Standing instructions for how to behave with this person
- Named entities that recur in their life (people, projects, repos, companies)

DO NOT store:
- What was discussed or asked. "User asked about X" is worthless.
- Anything the assistant said, explained, or generated.
- General world knowledge the model already has.
- One-off task details, transient state, or anything tied to this single conversation.
- Speculation. If it was not clearly stated, do not record it.

Rules:
- Each memory must be a standalone sentence, understandable with zero context.
  Bad: "he prefers that". Good: "Marcus prefers pull requests under 400 lines."
- Write in third person about the user. Do not use "you".
- importance: 0.9 = identity-level and permanent. 0.5 = useful context. 0.3 = minor.
- Prefer zero memories over weak ones. An empty array [] is a correct answer and
  is the right answer most of the time.

Return ONLY the JSON array. No prose, no code fence.`;

export interface ExtractionCandidate {
  content: string;
  kind: MemoryKind;
  importance: number;
  tags: string[];
}

export interface ExtractionContext {
  conversationId: string;
  messageId?: string;
  projectId?: string | null;
  profileId?: string | null;
  model?: ResolvedModel;
}

/**
 * Extracts and stores memories from one exchange.
 *
 * Never throws: this is background work triggered by a completed chat turn, and
 * a failure here must not surface to the user in any way.
 */
export async function extractMemories(
  exchange: Array<{ role: string; content: string }>,
  context: ExtractionContext,
): Promise<{ created: number; deduplicated: number }> {
  const settings = getSettings();
  if (!settings.memoryEnabled || !settings.memoryAutoExtract) {
    return { created: 0, deduplicated: 0 };
  }

  const transcript = exchange
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 12_000);

  // Too little was said for anything durable to be in it.
  if (transcript.length < 80) return { created: 0, deduplicated: 0 };

  const raw = await complete(
    context.model ?? resolveUtilityModel(),
    [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: `Conversation:\n\n${transcript}\n\nExtract memories.` },
    ],
    // Near-greedy: extraction should be reproducible, not creative.
    { temperature: 0.1, maxTokens: 1024, timeoutMs: 90_000 },
  );

  const candidates = parseCandidates(raw);
  let created = 0;
  let deduplicated = 0;

  for (const candidate of candidates) {
    try {
      const result = await createMemory({
        content: candidate.content,
        kind: candidate.kind,
        importance: candidate.importance,
        confidence: 0.75,
        source: 'auto',
        sourceConversationId: context.conversationId,
        sourceMessageId: context.messageId ?? null,
        projectId: context.projectId ?? null,
        profileId: context.profileId ?? null,
        tags: candidate.tags,
      });
      if (result.deduplicated) deduplicated++;
      else created++;
    } catch {
      // One bad candidate should not abort the rest of the batch.
    }
  }

  return { created, deduplicated };
}

/**
 * Parses the model's JSON array, tolerating the ways small models mangle it:
 * code fences, leading prose, trailing commentary.
 */
export function parseCandidates(raw: string): ExtractionCandidate[] {
  if (!raw.trim()) return [];

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: MemoryKind[] = ['fact', 'preference', 'event', 'entity', 'instruction', 'insight'];

  return parsed
    .map((item): ExtractionCandidate | null => {
      if (typeof item !== 'object' || item === null) return null;
      const record = item as Record<string, unknown>;

      const content = typeof record.content === 'string' ? record.content.trim() : '';
      // Sub-15-character "memories" are never real ones.
      if (content.length < 15) return null;

      // The model is told not to do this, and sometimes does it anyway.
      if (/^(the )?user (asked|wanted to know|inquired|requested help)/i.test(content)) return null;

      const kind = valid.includes(record.kind as MemoryKind) ? (record.kind as MemoryKind) : 'fact';
      const importanceRaw = typeof record.importance === 'number' ? record.importance : 0.5;

      return {
        content,
        kind,
        importance: Math.min(1, Math.max(0, importanceRaw)),
        tags: Array.isArray(record.tags)
          ? record.tags.filter((t): t is string => typeof t === 'string').slice(0, 6)
          : [],
      };
    })
    .filter((c): c is ExtractionCandidate => c !== null)
    // A single exchange producing more than five durable facts means the model
    // is padding. Keep the strongest.
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5);
}

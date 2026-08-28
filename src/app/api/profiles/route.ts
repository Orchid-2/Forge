/** GET /api/profiles — list personas. POST — create. */
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { profiles } from '@/db/schema';
import { createId } from '@/lib/ids';
import { boolParam, handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(async () => {
    const includeArchived = boolParam(
      new URL(request.url).searchParams.get('archived') ?? undefined,
    );

    const rows = getDb()
      .select()
      .from(profiles)
      .orderBy(asc(profiles.sortOrder), asc(profiles.name))
      .all();

    return { profiles: includeArchived ? rows : rows.filter((p) => !p.archived) };
  });
}

export const profileInput = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(200).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  systemPrompt: z.string().default(''),
  provider: z.enum(['ollama', 'llamacpp', 'openai-compat']).nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).max(200).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
  maxTokens: z.number().int().min(64).max(131072).optional(),
  contextWindow: z.number().int().min(512).max(1_048_576).nullable().optional(),
  stopSequences: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  memoryRead: z.boolean().optional(),
  memoryWrite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, profileInput);
    const db = getDb();
    const now = Date.now();

    // New personas go to the end of the list unless placed explicitly.
    const last = db.select().from(profiles).orderBy(desc(profiles.sortOrder)).get();

    const profile = db
      .insert(profiles)
      .values({
        ...input,
        id: createId('prof'),
        sortOrder: input.sortOrder ?? (last?.sortOrder ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return { profile };
  });
}

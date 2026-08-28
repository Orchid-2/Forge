/**
 * Hugging Face Hub integration — encrypted-at-rest-by-privacy backup.
 *
 * Conversations and memories are pushed to a *private* dataset repo as plain
 * JSON, so the backup is readable by any tool and restorable without Forge.
 * Repos are always created private; the code never offers a public option,
 * because the contents are somebody's personal conversation history.
 *
 * Sync is content-hash based: a conversation whose transcript has not changed
 * since the last push is skipped, which keeps an auto-sync cheap enough to run
 * after every turn.
 */
import 'server-only';

import { asc, desc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  conversations,
  memories,
  messages,
  syncState,
  type Conversation,
  type Memory,
  type Message,
} from '@/db/schema';
import { contentHash } from '@/lib/ids';
import { getSettings } from '@/lib/settings';

export interface HubStatus {
  configured: boolean;
  valid: boolean;
  repo: string;
  user?: string;
  error?: string;
  lastSyncAt?: number;
  syncedConversations?: number;
}

/** Where each kind of record lives inside the dataset repo. */
const PATHS = {
  manifest: 'forge/manifest.json',
  memories: 'forge/memories.jsonl',
  conversation: (id: string) => `forge/conversations/${id}.json`,
  readme: 'README.md',
};

function credentials() {
  const settings = getSettings();
  const token = settings.hfToken.trim();
  const repo = settings.hfBackupRepo.trim();
  return { token, repo };
}

/** Verifies the token works and reports who it belongs to. */
export async function checkHub(): Promise<HubStatus> {
  const { token, repo } = credentials();
  if (!token || !repo) {
    return { configured: false, valid: false, repo };
  }

  try {
    const { whoAmI } = await import('@huggingface/hub');
    const me = await whoAmI({ accessToken: token });

    const db = getDb();
    const state = db.select().from(syncState).where(eq(syncState.id, 'huggingface:all')).get();
    const synced = db
      .select()
      .from(syncState)
      .where(eq(syncState.target, 'huggingface'))
      .all()
      .filter((s) => s.entityId.startsWith('conv_')).length;

    return {
      configured: true,
      valid: true,
      repo,
      user: me.name,
      lastSyncAt: state?.syncedAt ?? undefined,
      syncedConversations: synced,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      repo,
      error: error instanceof Error ? error.message : 'Could not authenticate with Hugging Face.',
    };
  }
}

/**
 * Creates the backup dataset repo if it does not exist yet.
 *
 * `createRepo` throws when the repo already exists, which is the common case on
 * every sync after the first — so that specific failure is swallowed and any
 * other is raised.
 */
async function ensureRepo(token: string, repo: string): Promise<void> {
  const { createRepo } = await import('@huggingface/hub');
  try {
    await createRepo({
      repo: { type: 'dataset', name: repo },
      accessToken: token,
      visibility: 'private',
      files: [
        {
          path: PATHS.readme,
          content: new Blob([datasetCard(repo)], { type: 'text/markdown' }),
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/already (exists|created)|conflict/i.test(message)) throw error;
  }
}

function datasetCard(repo: string): string {
  return [
    '---',
    'tags:',
    '  - forge',
    '  - personal',
    'private: true',
    '---',
    '',
    `# ${repo}`,
    '',
    'Private backup of a [Forge](https://github.com/) workspace: conversations,',
    'extracted long-term memories, and a manifest describing the export.',
    '',
    '## Layout',
    '',
    '```',
    'forge/',
    '  manifest.json                 export metadata and counts',
    '  memories.jsonl                one memory per line',
    '  conversations/<id>.json       full transcript with metadata',
    '```',
    '',
    'Everything is plain JSON — restorable with or without Forge.',
    '',
    '> This dataset is personal. Keep it private.',
  ].join('\n');
}

export interface HubSyncSummary {
  conversations: number;
  memories: number;
  skipped: number;
  errors: string[];
}

/** Pushes one conversation. Used by the auto-sync hook after each turn. */
export async function syncConversationToHub(conversationId: string): Promise<boolean> {
  const { token, repo } = credentials();
  if (!token || !repo) return false;

  const db = getDb();
  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conversation) return false;

  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all();
  if (rows.length === 0) return false;

  const payload = serializeConversation(conversation, rows);
  const hash = contentHash(payload);
  const key = `${conversation.id}`;

  const previous = db.select().from(syncState).where(eq(syncState.id, key)).get();
  if (previous?.contentHash === hash && previous.status === 'synced') return false;

  await ensureRepo(token, repo);

  const { uploadFiles } = await import('@huggingface/hub');
  await uploadFiles({
    repo: { type: 'dataset', name: repo },
    accessToken: token,
    files: [
      {
        path: PATHS.conversation(conversation.id),
        content: new Blob([payload], { type: 'application/json' }),
      },
    ],
    commitTitle: `Update ${conversation.title}`,
  });

  recordHubSync(key, hash, PATHS.conversation(conversation.id));
  return true;
}

/**
 * Full push: every conversation plus the whole memory store.
 *
 * Conversations are uploaded in batches rather than one commit each — the Hub
 * rate-limits commits, and a user with 300 conversations would otherwise spend
 * several minutes creating 300 of them.
 */
export async function syncAllToHub(options: { force?: boolean } = {}): Promise<HubSyncSummary> {
  const { token, repo } = credentials();
  if (!token) throw new Error('No Hugging Face token configured.');
  if (!repo) throw new Error('No backup repository configured.');

  await ensureRepo(token, repo);

  const db = getDb();
  const summary: HubSyncSummary = { conversations: 0, memories: 0, skipped: 0, errors: [] };
  const { uploadFiles } = await import('@huggingface/hub');

  const conversationRows = db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.lastMessageAt))
    .all();

  const pending: Array<{ path: string; content: Blob; key: string; hash: string }> = [];

  for (const conversation of conversationRows) {
    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.seq))
      .all();

    if (rows.length === 0) {
      summary.skipped++;
      continue;
    }

    const payload = serializeConversation(conversation, rows);
    const hash = contentHash(payload);

    if (!options.force) {
      const previous = db.select().from(syncState).where(eq(syncState.id, conversation.id)).get();
      if (previous?.contentHash === hash && previous.status === 'synced') {
        summary.skipped++;
        continue;
      }
    }

    pending.push({
      path: PATHS.conversation(conversation.id),
      content: new Blob([payload], { type: 'application/json' }),
      key: conversation.id,
      hash,
    });
  }

  /* ── Memories: one JSONL file, always rewritten in full ─────────────────── */
  const memoryRows = db.select().from(memories).orderBy(desc(memories.createdAt)).all();
  const memoryPayload = memoryRows.map(serializeMemory).join('\n');
  const memoryHash = contentHash(memoryPayload);

  const previousMemories = db
    .select()
    .from(syncState)
    .where(eq(syncState.id, 'huggingface:memories'))
    .get();

  const memoriesChanged = options.force || previousMemories?.contentHash !== memoryHash;

  if (memoriesChanged && memoryRows.length > 0) {
    pending.push({
      path: PATHS.memories,
      content: new Blob([memoryPayload], { type: 'application/jsonl' }),
      key: 'huggingface:memories',
      hash: memoryHash,
    });
    summary.memories = memoryRows.length;
  }

  const manifest = JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: conversationRows.length,
      memories: memoryRows.length,
      generator: 'forge',
    },
    null,
    2,
  );

  pending.push({
    path: PATHS.manifest,
    content: new Blob([manifest], { type: 'application/json' }),
    key: 'huggingface:manifest',
    hash: contentHash(manifest),
  });

  // 25 files per commit keeps each request well inside the Hub's limits while
  // still collapsing a large export into a handful of commits.
  const BATCH_SIZE = 25;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      await uploadFiles({
        repo: { type: 'dataset', name: repo },
        accessToken: token,
        files: batch.map((f) => ({ path: f.path, content: f.content })),
        commitTitle: `Forge sync (${batch.length} files)`,
      });

      for (const file of batch) {
        recordHubSync(file.key, file.hash, file.path);
        if (file.key.startsWith('conv_')) summary.conversations++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed.';
      summary.errors.push(message);
      for (const file of batch) recordHubSync(file.key, null, file.path, message);
    }
  }

  recordHubSync('huggingface:all', null, repo, summary.errors[0]);
  return summary;
}

export interface HubPullSummary {
  conversations: number;
  memories: number;
  errors: string[];
}

/**
 * Restores from the backup repo.
 *
 * Additive by design: records that already exist locally are left alone. A pull
 * that silently overwrote local edits with an older backup would be the worst
 * possible failure mode for this feature.
 */
export async function pullFromHub(): Promise<HubPullSummary> {
  const { token, repo } = credentials();
  if (!token) throw new Error('No Hugging Face token configured.');
  if (!repo) throw new Error('No backup repository configured.');

  const { listFiles, downloadFile } = await import('@huggingface/hub');
  const db = getDb();
  const summary: HubPullSummary = { conversations: 0, memories: 0, errors: [] };

  const download = async (path: string): Promise<string | null> => {
    try {
      const response = await downloadFile({
        repo: { type: 'dataset', name: repo },
        path,
        accessToken: token,
      });
      return response ? await response.text() : null;
    } catch {
      return null;
    }
  };

  /* ── Memories ──────────────────────────────────────────────────────────── */
  const memoryText = await download(PATHS.memories);
  if (memoryText) {
    const { createMemory } = await import('@/lib/memory');

    for (const line of memoryText.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Partial<Memory>;
        if (!record.id || !record.content) continue;

        const exists = db.select().from(memories).where(eq(memories.id, record.id)).get();
        if (exists) continue;

        await createMemory({
          content: record.content,
          title: record.title ?? undefined,
          kind: record.kind ?? 'fact',
          importance: record.importance ?? 0.5,
          confidence: record.confidence ?? 0.8,
          source: 'import',
          tags: record.tags ?? [],
          pinned: record.pinned ?? false,
        });
        summary.memories++;
      } catch {
        /* skip malformed line */
      }
    }
  }

  /* ── Conversations ─────────────────────────────────────────────────────── */
  try {
    for await (const file of listFiles({
      repo: { type: 'dataset', name: repo },
      path: 'forge/conversations',
      recursive: true,
      accessToken: token,
    })) {
      if (!file.path.endsWith('.json')) continue;

      const text = await download(file.path);
      if (!text) continue;

      try {
        const record = JSON.parse(text) as {
          conversation: Conversation;
          messages: Message[];
        };
        if (!record.conversation?.id) continue;

        const exists = db
          .select()
          .from(conversations)
          .where(eq(conversations.id, record.conversation.id))
          .get();
        if (exists) continue;

        db.transaction((tx) => {
          tx.insert(conversations).values({ ...record.conversation }).run();
          for (const message of record.messages ?? []) {
            tx.insert(messages)
              .values({ ...message, conversationId: record.conversation.id })
              .run();
          }
        });
        summary.conversations++;
      } catch (error) {
        summary.errors.push(
          `${file.path}: ${error instanceof Error ? error.message : 'malformed'}`,
        );
      }
    }
  } catch (error) {
    summary.errors.push(error instanceof Error ? error.message : 'Could not list files.');
  }

  return summary;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Serialisation
 * ──────────────────────────────────────────────────────────────────────────── */

function serializeConversation(conversation: Conversation, rows: Message[]): string {
  return JSON.stringify(
    {
      conversation,
      messages: rows,
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

/** Memories go out as JSONL minus the embedding — it is regenerable and large. */
function serializeMemory(memory: Memory): string {
  const { embedding: _embedding, ...rest } = memory;
  return JSON.stringify(rest);
}

function recordHubSync(
  key: string,
  hash: string | null,
  remoteRef: string,
  error?: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.insert(syncState)
    .values({
      id: key,
      target: 'huggingface',
      entityId: key,
      contentHash: hash,
      remoteRef,
      status: error ? 'error' : 'synced',
      error: error ?? null,
      syncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncState.id,
      set: {
        contentHash: hash,
        remoteRef,
        status: error ? 'error' : 'synced',
        error: error ?? null,
        syncedAt: now,
        updatedAt: now,
      },
    })
    .run();
}

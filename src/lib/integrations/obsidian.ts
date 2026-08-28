/**
 * Obsidian vault integration.
 *
 * Forge writes plain Markdown with YAML frontmatter into a folder of your vault
 * — no plugin, no database, no lock-in. Notes are linked with `[[wikilinks]]`
 * so conversations and the memories extracted from them show up connected in
 * Obsidian's graph view.
 *
 * Everything Forge owns lives under one configurable folder (default `Forge/`).
 * The rest of the vault is never touched.
 */
import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import { asc, desc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  conversations,
  memories,
  messages,
  profiles,
  projects,
  syncState,
  type Conversation,
  type Memory,
} from '@/db/schema';
import { contentHash, createId } from '@/lib/ids';
import { getSettings } from '@/lib/settings';

export interface VaultStatus {
  configured: boolean;
  valid: boolean;
  path: string;
  folder: string;
  error?: string;
  noteCount?: number;
}

/**
 * Verifies the configured path is a real Obsidian vault.
 *
 * The `.obsidian` directory is the marker. Checking for it prevents the common
 * and destructive mistake of pointing Forge at a home directory and having it
 * scatter notes there.
 */
export async function checkVault(): Promise<VaultStatus> {
  const settings = getSettings();
  const vaultPath = settings.obsidianVaultPath.trim();
  const folder = settings.obsidianFolder.trim() || 'Forge';

  if (!vaultPath) {
    return { configured: false, valid: false, path: '', folder };
  }

  try {
    const stat = await fs.stat(vaultPath);
    if (!stat.isDirectory()) {
      return { configured: true, valid: false, path: vaultPath, folder, error: 'Not a directory.' };
    }

    try {
      await fs.access(path.join(vaultPath, '.obsidian'));
    } catch {
      return {
        configured: true,
        valid: false,
        path: vaultPath,
        folder,
        error: 'No .obsidian folder here — this does not look like a vault.',
      };
    }

    let noteCount: number | undefined;
    try {
      const entries = await fs.readdir(path.join(vaultPath, folder), { recursive: true });
      noteCount = entries.filter((e) => String(e).endsWith('.md')).length;
    } catch {
      // Folder not created yet; that is fine, the first sync makes it.
      noteCount = 0;
    }

    return { configured: true, valid: true, path: vaultPath, folder, noteCount };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      path: vaultPath,
      folder,
      error: error instanceof Error ? error.message : 'Cannot read the vault path.',
    };
  }
}

/** Throws unless the vault is configured and valid. */
async function requireVault(): Promise<{ root: string; folder: string }> {
  const status = await checkVault();
  if (!status.configured) throw new Error('No Obsidian vault configured.');
  if (!status.valid) throw new Error(status.error ?? 'Vault is not accessible.');
  return { root: status.path, folder: status.folder };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Conversations → notes
 * ──────────────────────────────────────────────────────────────────────────── */

export async function syncConversationToVault(conversationId: string): Promise<string | null> {
  const { root, folder } = await requireVault();
  const db = getDb();

  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!conversation) return null;

  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq))
    .all();

  // An empty conversation would just be frontmatter noise in the vault.
  if (rows.length === 0) return null;

  const project = conversation.projectId
    ? db.select().from(projects).where(eq(projects.id, conversation.projectId)).get()
    : null;
  const profile = conversation.profileId
    ? db.select().from(profiles).where(eq(profiles.id, conversation.profileId)).get()
    : null;

  // Memories extracted from this conversation become outbound wikilinks, which
  // is what makes the graph view useful rather than a pile of orphan notes.
  const linkedMemories = db
    .select()
    .from(memories)
    .where(eq(memories.sourceConversationId, conversationId))
    .all();

  const markdown = renderConversationNote(conversation, rows, {
    projectName: project?.name,
    profileName: profile?.name,
    memories: linkedMemories,
    wikilinks: getSettings().obsidianWikilinks,
  });

  // Project conversations nest under the project, mirroring how someone would
  // organise this by hand.
  const directory = project
    ? path.join(root, folder, 'Projects', sanitizeSegment(project.name))
    : path.join(root, folder, 'Conversations');

  const filePath = path.join(directory, `${sanitizeSegment(conversation.title)}.md`);

  await writeIfChanged(filePath, markdown, `obsidian:conv:${conversationId}`);
  return filePath;
}

function renderConversationNote(
  conversation: Conversation,
  rows: Array<{ role: string; content: string; createdAt: number; model: string | null; pinned: boolean }>,
  context: {
    projectName?: string;
    profileName?: string;
    memories: Memory[];
    wikilinks: boolean;
  },
): string {
  const created = new Date(conversation.createdAt).toISOString();
  const updated = new Date(conversation.lastMessageAt).toISOString();

  const tags = ['forge/conversation'];
  if (context.projectName) tags.push(`forge/project/${slug(context.projectName)}`);
  if (context.profileName) tags.push(`forge/persona/${slug(context.profileName)}`);

  const frontmatter = [
    '---',
    `title: ${yamlString(conversation.title)}`,
    `created: ${created}`,
    `updated: ${updated}`,
    `messages: ${conversation.messageCount}`,
    `tokens: ${conversation.tokenCount}`,
    context.projectName ? `project: ${yamlString(context.projectName)}` : '',
    context.profileName ? `persona: ${yamlString(context.profileName)}` : '',
    conversation.model ? `model: ${yamlString(conversation.model)}` : '',
    `tags: [${tags.join(', ')}]`,
    'source: forge',
    `forge-id: ${conversation.id}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  const body = rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const heading = m.role === 'user' ? '### You' : `### ${context.profileName ?? 'Assistant'}`;
      const pin = m.pinned ? ' 📌' : '';
      const time = new Date(m.createdAt).toLocaleString();
      return `${heading}${pin}\n<small>${time}</small>\n\n${m.content}`;
    })
    .join('\n\n---\n\n');

  const sections = [frontmatter, `# ${conversation.title}`];

  if (conversation.summary) {
    sections.push(`> [!summary] Summary\n> ${conversation.summary.replace(/\n/g, '\n> ')}`);
  }

  sections.push(body);

  if (context.memories.length > 0) {
    const links = context.memories
      .map((m) => {
        const name = sanitizeSegment(m.title ?? m.content.slice(0, 60));
        return context.wikilinks ? `- [[${name}]]` : `- ${m.content}`;
      })
      .join('\n');
    sections.push(`## Memories from this conversation\n\n${links}`);
  }

  return `${sections.join('\n\n')}\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Memories → notes
 * ──────────────────────────────────────────────────────────────────────────── */

export async function syncMemoryToVault(memoryId: string): Promise<string | null> {
  const { root, folder } = await requireVault();
  const db = getDb();

  const memory = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!memory) return null;

  const conversation = memory.sourceConversationId
    ? db.select().from(conversations).where(eq(conversations.id, memory.sourceConversationId)).get()
    : null;

  const markdown = renderMemoryNote(memory, {
    conversationTitle: conversation?.title,
    wikilinks: getSettings().obsidianWikilinks,
  });

  // Filing by kind means the vault's folder tree is itself a useful index.
  const directory = path.join(root, folder, 'Memories', capitalize(memory.kind));
  const filePath = path.join(directory, `${sanitizeSegment(memory.title ?? memory.content.slice(0, 60))}.md`);

  await writeIfChanged(filePath, markdown, `obsidian:mem:${memoryId}`);
  return filePath;
}

function renderMemoryNote(
  memory: Memory,
  context: { conversationTitle?: string; wikilinks: boolean },
): string {
  const tags = ['forge/memory', `forge/memory/${memory.kind}`, ...(memory.tags ?? []).map(slug)];

  const frontmatter = [
    '---',
    `kind: ${memory.kind}`,
    `importance: ${memory.importance.toFixed(2)}`,
    `confidence: ${memory.confidence.toFixed(2)}`,
    `created: ${new Date(memory.createdAt).toISOString()}`,
    memory.pinned ? 'pinned: true' : '',
    `tags: [${tags.join(', ')}]`,
    'source: forge',
    `forge-id: ${memory.id}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  const sections = [frontmatter, `# ${memory.title ?? 'Memory'}`, memory.content];

  if (context.conversationTitle) {
    // The backlink is what makes this bi-directional: the conversation note
    // links here, and this links back.
    sections.push(
      context.wikilinks
        ? `## Source\n\n[[${sanitizeSegment(context.conversationTitle)}]]`
        : `## Source\n\n${context.conversationTitle}`,
    );
  }

  return `${sections.join('\n\n')}\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Bulk sync
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SyncSummary {
  conversations: number;
  memories: number;
  skipped: number;
  errors: string[];
}

/** Exports everything. Unchanged notes are skipped via their content hash. */
export async function syncAllToVault(
  options: { limit?: number } = {},
): Promise<SyncSummary> {
  await requireVault();
  const db = getDb();
  const summary: SyncSummary = { conversations: 0, memories: 0, skipped: 0, errors: [] };

  const conversationRows = db
    .select()
    .from(conversations)
    .where(eq(conversations.archived, false))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(options.limit ?? 500)
    .all();

  for (const conversation of conversationRows) {
    try {
      const written = await syncConversationToVault(conversation.id);
      if (written) summary.conversations++;
      else summary.skipped++;
    } catch (error) {
      summary.errors.push(
        `${conversation.title}: ${error instanceof Error ? error.message : 'failed'}`,
      );
    }
  }

  const memoryRows = db
    .select()
    .from(memories)
    .where(eq(memories.archived, false))
    .orderBy(desc(memories.createdAt))
    .limit(options.limit ?? 2000)
    .all();

  for (const memory of memoryRows) {
    try {
      await syncMemoryToVault(memory.id);
      summary.memories++;
    } catch (error) {
      summary.errors.push(
        `${memory.title ?? memory.id}: ${error instanceof Error ? error.message : 'failed'}`,
      );
    }
  }

  recordSync('obsidian', '*', 'synced');
  return summary;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Filesystem helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Writes a note only when its content actually changed.
 *
 * Obsidian watches the filesystem; rewriting identical files on every sync
 * would churn its index and clutter the user's file-recency ordering for no
 * reason.
 */
async function writeIfChanged(filePath: string, content: string, syncKey: string): Promise<boolean> {
  const hash = contentHash(content);
  const db = getDb();

  const previous = db.select().from(syncState).where(eq(syncState.id, syncKey)).get();

  if (previous?.contentHash === hash) {
    // Trust the hash only if the file is still there — a user may have deleted
    // it in Obsidian and expect a re-sync to restore it.
    try {
      await fs.access(filePath);
      return false;
    } catch {
      /* fall through and rewrite */
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');

  recordSync('obsidian', syncKey, 'synced', hash, filePath);
  return true;
}

function recordSync(
  target: 'obsidian' | 'huggingface',
  key: string,
  status: 'synced' | 'error',
  hash?: string,
  remoteRef?: string,
  error?: string,
): void {
  const db = getDb();
  const now = Date.now();
  const id = key === '*' ? `${target}:all` : key;

  db.insert(syncState)
    .values({
      id,
      target,
      entityId: key,
      contentHash: hash ?? null,
      remoteRef: remoteRef ?? null,
      status,
      error: error ?? null,
      syncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncState.id,
      set: {
        contentHash: hash ?? null,
        remoteRef: remoteRef ?? null,
        status,
        error: error ?? null,
        syncedAt: now,
        updatedAt: now,
      },
    })
    .run();
}

/**
 * Makes a string safe as a filename on every platform.
 *
 * Also strips `[`, `]`, `#` and `^`, which are Obsidian link syntax and break
 * wikilinks when they appear in a note title.
 */
export function sanitizeSegment(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Windows reserves these names regardless of extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `_${cleaned}`;

  return (cleaned || 'Untitled').slice(0, 120);
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Escapes a value for a YAML scalar. */
function yamlString(input: string): string {
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

/** Unused import guard: keeps `createId` available for future note types. */
export const __obsidianInternals = { createId };

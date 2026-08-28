/**
 * Smoke test: exercises the database, schema, FTS and memory maths without
 * needing a model backend. Run with `node scripts/smoke.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve('data/smoke.db');
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(`${DB_PATH}-wal`, { force: true });
fs.rmSync(`${DB_PATH}-shm`, { force: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply the generated migration exactly as the app does.
const dir = path.resolve('drizzle');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let statements = 0;
for (const file of files) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
    db.exec(statement);
    statements++;
  }
}
console.log(`✓ applied ${files.length} migration file(s), ${statements} statements`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const expected = ['activity','adapters','conversations','custom_tools','goal_entries','goals','mcp_servers','memories','memory_links','message_versions','messages','models','profiles','projects','settings','sync_state'];
const missing = expected.filter((t) => !tables.includes(t));
if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);
console.log(`✓ ${expected.length} tables created`);

// FTS5 virtual tables + triggers, as `applySchema` creates them.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, title, tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (id, content, title) VALUES (new.id, new.content, COALESCE(new.title,''));
  END;
  CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE id = old.id;
  END;
`);
console.log('✓ FTS5 available');

// Insert a memory and confirm the trigger indexed it.
const now = Date.now();
db.prepare(`INSERT INTO memories (id, content, title, kind, importance, confidence, source, tags, pinned, archived, access_count, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('mem_test_1', 'Marcus prefers pull requests under 400 lines and reviews them same-day.', 'PR size preference', 'preference', 0.8, 1, 'manual', '[]', 0, 0, 0, now, now);

const hit = db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ?').get('"pull"');
if (!hit) throw new Error('FTS trigger did not index the memory');
console.log('✓ FTS insert trigger works, BM25 match found');

db.prepare('DELETE FROM memories WHERE id = ?').run('mem_test_1');
if (db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ?').get('"pull"')) {
  throw new Error('FTS delete trigger did not clean up');
}
console.log('✓ FTS delete trigger works');

// Foreign key cascade: deleting a conversation must take its messages.
db.prepare(`INSERT INTO conversations (id, title, title_generated, summarized_until, message_count, token_count, pinned, archived, last_message_at, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('conv_1','Test',0,0,0,0,0,0,now,now,now);
db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, content, prompt_tokens, completion_tokens, duration_ms, pinned, version_count, active_version, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('msg_1','conv_1',0,'user','hello',0,0,0,0,1,0,now,now);
db.prepare('DELETE FROM conversations WHERE id = ?').run('conv_1');
if (db.prepare('SELECT id FROM messages WHERE id = ?').get('msg_1')) {
  throw new Error('cascade delete did not remove messages');
}
console.log('✓ foreign key cascade works');

// Float32 BLOB round-trip — the storage format for embeddings.
const vector = new Float32Array([0.5, -0.25, 0.125, 1]);
const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
db.prepare(`INSERT INTO memories (id, content, kind, importance, confidence, source, tags, pinned, archived, access_count, embedding, embedding_dim, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('mem_vec', 'vector test', 'fact', 0.5, 0.8, 'manual', '[]', 0, 0, 0, blob, 4, now, now);
const stored = db.prepare('SELECT embedding FROM memories WHERE id = ?').get('mem_vec').embedding;
// Mirrors lib/memory/embeddings.ts#fromBlob: respect the byte offset, and copy
// into an owned buffer when SQLite hands back a misaligned pooled Buffer.
const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
let restored;
if (bytes.byteOffset % 4 === 0) {
  restored = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
} else {
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  restored = new Float32Array(aligned.buffer, 0, bytes.byteLength / 4);
}
if (restored.length !== 4 || Math.abs(restored[3] - 1) > 1e-6 || Math.abs(restored[1] + 0.25) > 1e-6) {
  throw new Error(`vector round-trip failed: [${Array.from(restored).join(', ')}]`);
}
console.log('✓ Float32 embedding BLOB round-trips exactly');

// The date-bucketing SQL the dashboard depends on.
const bucket = db.prepare(`SELECT strftime('%Y-%m-%d', ? / 1000, 'unixepoch', 'localtime') AS day`).get(now).day;
if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) throw new Error(`bad day bucket: ${bucket}`);
console.log(`✓ dashboard day bucketing works (${bucket})`);

// Regression: a partial settings update must not resurrect defaults for keys
// the caller never sent. Zod's `.partial()` leaves `.default()` in place, so
// parsing { theme } would return every key — and persisting that would wipe the
// user's tokens and paths on any unrelated save. See lib/settings-defaults.ts.
{
  const { z } = await import('zod');
  const schema = z.object({
    token: z.string().default(''),
    theme: z.enum(['dark', 'light']).default('dark'),
    topK: z.number().min(1).max(50).default(12),
  });

  const patchSchema = z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => [
        key,
        (field instanceof z.ZodDefault ? field.unwrap() : field).optional(),
      ]),
    ),
  );

  const parsed = patchSchema.parse({ theme: 'light' });
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'theme') {
    throw new Error(`settings patch leaked defaults: ${JSON.stringify(parsed)}`);
  }

  // Constraints must survive the unwrap.
  let rejected = false;
  try {
    patchSchema.parse({ topK: 999 });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('settings patch dropped its range validation');

  console.log('✓ settings patch keeps absent keys absent, and still validates');
}

db.close();
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(`${DB_PATH}-wal`, { force: true });
fs.rmSync(`${DB_PATH}-shm`, { force: true });
console.log('\nAll database checks passed.');

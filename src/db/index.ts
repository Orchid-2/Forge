/**
 * Database client.
 *
 * A single better-sqlite3 connection is shared across the process and cached on
 * `globalThis` so Next's dev-mode module reloading doesn't leak file handles.
 * Migrations and seeding run exactly once, lazily, on first access — that is
 * what makes `pnpm dev` a true zero-step install.
 */
import 'server-only';

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';
import { applySchema } from './migrate';
import { seedIfEmpty } from './seed';

export type ForgeDatabase = BetterSQLite3Database<typeof schema>;

interface DbHandle {
  db: ForgeDatabase;
  sqlite: Database.Database;
}

// Dev-mode HMR would otherwise open a new connection on every module reload.
const globalForDb = globalThis as unknown as { __forgeDb?: DbHandle };

/** Absolute path to the directory holding the db, models and caches. */
export function dataDir(): string {
  const configured = process.env.FORGE_DATA_DIR ?? './data';
  return path.resolve(process.cwd(), configured);
}

function databasePath(): string {
  if (process.env.FORGE_DB_PATH) return path.resolve(process.cwd(), process.env.FORGE_DB_PATH);
  return path.join(dataDir(), 'forge.db');
}

function open(): DbHandle {
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);

  // WAL lets the streaming chat route read while a background memory-extraction
  // job writes, without either blocking the other.
  sqlite.pragma('journal_mode = WAL');
  // NORMAL trades a vanishingly small crash window for a large write speedup.
  // Appropriate for a local personal app; FULL would fsync on every commit.
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  // 64 MB page cache — the whole database usually fits, making reads memory-fast.
  sqlite.pragma('cache_size = -64000');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });

  applySchema(sqlite);
  seedIfEmpty(db);

  return { db, sqlite };
}

/** The shared database handle. Safe to call from any server module. */
export function getDb(): ForgeDatabase {
  if (!globalForDb.__forgeDb) globalForDb.__forgeDb = open();
  return globalForDb.__forgeDb.db;
}

/** Raw connection, for FTS queries and other things Drizzle doesn't model. */
export function getSqlite(): Database.Database {
  if (!globalForDb.__forgeDb) globalForDb.__forgeDb = open();
  return globalForDb.__forgeDb.sqlite;
}

export { schema };
export * from './schema';

import type { Config } from 'drizzle-kit';

/**
 * The database lives inside ./data so the whole app state (db + downloaded
 * models + caches) is one portable, gitignored directory.
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.FORGE_DB_PATH ?? './data/forge.db',
  },
  verbose: true,
  strict: true,
} satisfies Config;

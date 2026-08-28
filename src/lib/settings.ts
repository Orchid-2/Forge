/**
 * Server-side settings access.
 *
 * Reads are hot-path (every chat request touches several keys) so the whole
 * settings table is cached in memory and invalidated on write. It is a handful
 * of rows — caching it is strictly better than a query per key.
 */
import 'server-only';

import { getDb } from '@/db';
import { settings } from '@/db/schema';
import {
  DEFAULT_SETTINGS,
  ENV_FALLBACKS,
  SECRET_KEYS,
  SECRET_MASK,
  settingsSchema,
  type SettingKey,
  type Settings,
} from './settings-defaults';

const globalForSettings = globalThis as unknown as { __forgeSettings?: Settings | null };

/** Applies the database → environment → default resolution order. */
function load(): Settings {
  const db = getDb();
  const rows = db.select().from(settings).all();

  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      // A hand-edited database shouldn't take the app down; fall through to the
      // default for that one key.
      raw[row.key] = undefined;
    }
  }

  for (const [key, envValue] of Object.entries(ENV_FALLBACKS)) {
    if (envValue === undefined || envValue === '') continue;
    const current = raw[key];
    // Only fill in when the stored value is still the untouched default.
    if (current === undefined || current === '' || current === null) raw[key] = envValue;
  }

  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
}

export function getSettings(): Settings {
  if (!globalForSettings.__forgeSettings) globalForSettings.__forgeSettings = load();
  return globalForSettings.__forgeSettings;
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return getSettings()[key];
}

export function invalidateSettingsCache(): void {
  globalForSettings.__forgeSettings = null;
}

/**
 * Persists a partial update. Secret keys arriving as the mask are dropped —
 * that means the user never edited the field, and writing the mask through
 * would destroy a working token.
 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  const now = Date.now();

  const entries = Object.entries(patch).filter(([key, value]) => {
    if ((SECRET_KEYS as readonly string[]).includes(key) && value === SECRET_MASK) return false;
    return value !== undefined;
  });

  if (entries.length > 0) {
    db.transaction((tx) => {
      for (const [key, value] of entries) {
        tx.insert(settings)
          .values({ key, value: JSON.stringify(value), updatedAt: now })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: JSON.stringify(value), updatedAt: now },
          })
          .run();
      }
    });
  }

  invalidateSettingsCache();
  return getSettings();
}

/** Settings shaped for the client: secrets replaced with a "is set" placeholder. */
export function getPublicSettings(): Settings {
  const all = { ...getSettings() };
  for (const key of SECRET_KEYS) {
    if (all[key]) all[key] = SECRET_MASK as never;
  }
  return all;
}

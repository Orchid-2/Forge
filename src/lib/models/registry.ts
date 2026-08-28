/**
 * Model registry.
 *
 * Two kinds of model coexist: those *discovered* by asking a running backend
 * what it has loaded, and those *downloaded* by Forge from Hugging Face. This
 * module reconciles both into one table so the switcher can show a single list.
 */
import 'server-only';

import { and, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db';
import { models, adapters, type ModelRow, type ProviderId } from '@/db/schema';
import { createId } from '@/lib/ids';
import { discoverModels, getProvider, OllamaProvider } from '@/lib/llm';
import { getSettings } from '@/lib/settings';

/**
 * Reconciles the registry with what the backends actually report.
 *
 * Models that vanished from a backend are marked `missing` rather than deleted:
 * a stopped `llama-server` should not wipe the user's model list, and the row
 * carries download provenance worth keeping.
 */
export async function refreshRegistry(): Promise<{ discovered: number; missing: number }> {
  const db = getDb();
  const discovered = await discoverModels();
  const now = Date.now();

  const seen = new Set<string>();

  for (const model of discovered) {
    const key = `${model.provider}:${model.name}`;
    seen.add(key);

    const existing = db
      .select()
      .from(models)
      .where(and(eq(models.provider, model.provider), eq(models.name, model.name)))
      .get();

    if (existing) {
      db.update(models)
        .set({
          displayName: model.displayName ?? existing.displayName,
          family: model.family ?? existing.family,
          parameterSize: model.parameterSize ?? existing.parameterSize,
          quantization: model.quantization ?? existing.quantization,
          sizeBytes: model.sizeBytes || existing.sizeBytes,
          contextLength: model.contextLength ?? existing.contextLength,
          status: 'ready',
          updatedAt: now,
        })
        .where(eq(models.id, existing.id))
        .run();
      continue;
    }

    db.insert(models)
      .values({
        id: createId('model'),
        name: model.name,
        displayName: model.displayName ?? model.name,
        provider: model.provider,
        family: model.family,
        parameterSize: model.parameterSize,
        quantization: model.quantization,
        sizeBytes: model.sizeBytes ?? 0,
        contextLength: model.contextLength,
        source: model.provider === 'ollama' ? 'ollama' : 'llamacpp',
        status: 'ready',
        capabilities: {
          tools: model.supportsTools ?? false,
          vision: model.supportsVision ?? false,
          embedding: model.isEmbedding ?? false,
          reasoning: /reason|think|r1|qwq/i.test(model.name),
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Anything previously discovered from a backend but absent now is missing.
  const registered = db
    .select()
    .from(models)
    .where(inArray(models.source, ['ollama', 'llamacpp', 'openai-compat']))
    .all();

  let missing = 0;
  for (const row of registered) {
    if (seen.has(`${row.provider}:${row.name}`)) continue;
    if (row.status === 'downloading') continue;
    db.update(models).set({ status: 'missing', updatedAt: now }).where(eq(models.id, row.id)).run();
    missing++;
  }

  return { discovered: discovered.length, missing };
}

export function listModels(options: { includeMissing?: boolean } = {}): ModelRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(models)
    .orderBy(desc(models.favorite), desc(models.lastUsedAt), desc(models.createdAt))
    .all();

  return options.includeMissing ? rows : rows.filter((r) => r.status !== 'missing');
}

export function listAdapters() {
  return getDb().select().from(adapters).orderBy(desc(adapters.createdAt)).all();
}

/** Deep metadata for one model, fetched live from its backend. */
export async function describeModel(id: string) {
  const db = getDb();
  const row = db.select().from(models).where(eq(models.id, id)).get();
  if (!row) return null;

  if (row.provider === 'ollama') {
    const provider = getProvider('ollama');
    if (provider instanceof OllamaProvider) {
      const detail = await provider.describeModel(row.name);
      if (detail) {
        // Capabilities are authoritative here, unlike the name-based guess made
        // during discovery, so persist them.
        db.update(models)
          .set({
            contextLength: detail.contextLength ?? row.contextLength,
            family: detail.family ?? row.family,
            parameterSize: detail.parameterSize ?? row.parameterSize,
            quantization: detail.quantization ?? row.quantization,
            capabilities: {
              tools: detail.supportsTools ?? false,
              vision: detail.supportsVision ?? false,
              embedding: detail.isEmbedding ?? false,
              reasoning: row.capabilities?.reasoning ?? false,
            },
            updatedAt: Date.now(),
          })
          .where(eq(models.id, id))
          .run();

        return { ...row, ...detail };
      }
    }
  }

  return row;
}

export function setFavorite(id: string, favorite: boolean): void {
  getDb().update(models).set({ favorite, updatedAt: Date.now() }).where(eq(models.id, id)).run();
}

/** Removes a model from the backend that holds it, then from the registry. */
export async function removeModel(id: string): Promise<void> {
  const db = getDb();
  const row = db.select().from(models).where(eq(models.id, id)).get();
  if (!row) return;

  if (row.source === 'huggingface') {
    const { deleteDownload } = await import('./huggingface');
    await deleteDownload(id);
    return;
  }

  if (row.provider === 'ollama') {
    const provider = getProvider('ollama');
    if (provider instanceof OllamaProvider) {
      await provider.deleteModel(row.name).catch(() => {
        // Already gone from Ollama, or Ollama is down. Either way the registry
        // row should still go.
      });
    }
  }

  db.delete(models).where(eq(models.id, id)).run();
}

/**
 * Suggests a default model when the user has never picked one.
 *
 * Prefers an instruct-tuned chat model of moderate size — the thing most likely
 * to give a good first impression — over whatever happens to sort first.
 */
export function suggestDefaultModel(): { provider: ProviderId; model: string } | null {
  const rows = listModels().filter((r) => !r.capabilities?.embedding);
  if (rows.length === 0) return null;

  const scored = rows.map((row) => {
    let score = 0;
    if (/instruct|chat|it\b/i.test(row.name)) score += 3;
    if (row.capabilities?.tools) score += 2;
    if (row.favorite) score += 5;
    if (row.lastUsedAt) score += 4;
    // Very large models are slow to first token on consumer hardware, and very
    // small ones disappoint. 4-14B is the sweet spot for a default.
    const params = Number(row.parameterSize?.replace(/[^\d.]/g, '') ?? 0);
    if (params >= 4 && params <= 14) score += 2;
    return { row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.row;
  return best ? { provider: best.provider, model: best.name } : null;
}

/** Ensures a default model is set, picking one if the user has not. */
export async function ensureDefaultModel(): Promise<void> {
  const settings = getSettings();
  if (settings.defaultModel) return;

  await refreshRegistry().catch(() => {});
  const suggestion = suggestDefaultModel();
  if (!suggestion) return;

  const { updateSettings } = await import('@/lib/settings');
  updateSettings({ defaultProvider: suggestion.provider, defaultModel: suggestion.model });
}

/**
 * Hugging Face model browser.
 *   GET  ?q=...            search repos
 *   GET  ?repo=...         list the weight files in one repo
 *   POST                   start a download
 */
import { z } from 'zod';

import { listHfFiles, searchHfModels, startDownload } from '@/lib/models/huggingface';
import { ApiError, handle, parseBody, parseQuery } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const getQuery = z.object({
  q: z.string().optional(),
  repo: z.string().optional(),
  library: z.enum(['gguf', 'safetensors', 'all']).optional(),
  adapters: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export async function GET(request: Request) {
  return handle(async () => {
    const query = parseQuery(request, getQuery);

    if (query.repo) {
      return { repo: query.repo, files: await listHfFiles(query.repo) };
    }

    if (!query.q?.trim()) {
      throw new ApiError('Provide a search query (?q=) or a repo (?repo=).');
    }

    return {
      models: await searchHfModels(query.q, {
        library: query.library,
        limit: query.limit,
        adaptersOnly: query.adapters === 'true',
      }),
    };
  });
}

const downloadSchema = z.object({
  repoId: z.string().min(1),
  filename: z.string().min(1),
  asAdapter: z.boolean().optional(),
  baseModelId: z.string().nullable().optional(),
  displayName: z.string().optional(),
});

export async function POST(request: Request) {
  return handle(async () => {
    const input = await parseBody(request, downloadSchema);

    // Returns as soon as the transfer is registered; progress is polled from
    // /api/models, since a multi-gigabyte download outlives any request.
    const { id } = await startDownload({
      ...input,
      baseModelId: input.baseModelId ?? undefined,
    });

    return { id, started: true };
  });
}

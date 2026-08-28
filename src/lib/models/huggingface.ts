/**
 * Hugging Face model discovery and download.
 *
 * Uses the Hub's public REST API directly rather than the SDK: we need byte-level
 * streaming with resume support to download multi-gigabyte GGUF files without
 * buffering them in memory, and a plain `fetch` with a Range header is the
 * clearest way to get that.
 *
 * Downloads run detached from the request that started them — a 20GB model
 * outlives any HTTP timeout — and report progress by writing to the `models`
 * row, which the UI polls.
 */
import 'server-only';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { eq } from 'drizzle-orm';

import { dataDir, getDb } from '@/db';
import { activity, adapters, models } from '@/db/schema';
import { createId } from '@/lib/ids';
import { getSettings } from '@/lib/settings';

const HF_API = 'https://huggingface.co/api';
const HF_RESOLVE = 'https://huggingface.co';

export interface HfModelSummary {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  updatedAt: string;
  tags: string[];
  pipelineTag?: string;
  gated: boolean;
  /** True when the repo looks like a LoRA adapter rather than a base model. */
  isAdapter: boolean;
}

export interface HfFile {
  path: string;
  size: number;
  /** Parsed from the filename, e.g. "Q4_K_M". */
  quantization?: string;
  /** True for the first shard of a split GGUF, which is the one to download. */
  isShardIndex?: boolean;
}

function authHeaders(): Record<string, string> {
  const token = getSettings().hfToken.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Searches the Hub.
 *
 * Defaults to GGUF because that is what Ollama and llama.cpp consume; the
 * `library` filter is exposed so the UI can offer safetensors for vLLM users.
 */
export async function searchHfModels(
  query: string,
  options: { library?: 'gguf' | 'safetensors' | 'all'; limit?: number; adaptersOnly?: boolean } = {},
): Promise<HfModelSummary[]> {
  const url = new URL(`${HF_API}/models`);
  url.searchParams.set('search', query);
  url.searchParams.set('limit', String(options.limit ?? 24));
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('full', 'true');

  if (options.adaptersOnly) url.searchParams.append('filter', 'peft');
  else if (options.library !== 'all') url.searchParams.append('filter', options.library ?? 'gguf');

  const response = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Hugging Face search failed with HTTP ${response.status}.`);
  }

  const data = (await response.json()) as Array<{
    id: string;
    author?: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
    tags?: string[];
    pipeline_tag?: string;
    gated?: boolean | string;
  }>;

  return data.map((m) => {
    const tags = m.tags ?? [];
    return {
      id: m.id,
      author: m.author ?? m.id.split('/')[0],
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      updatedAt: m.lastModified ?? '',
      tags,
      pipelineTag: m.pipeline_tag,
      // `gated` is `false` or a string naming the gate type.
      gated: Boolean(m.gated),
      isAdapter: tags.includes('peft') || tags.includes('lora') || /lora|adapter/i.test(m.id),
    };
  });
}

/** Lists the downloadable weight files in a repo. */
export async function listHfFiles(repoId: string): Promise<HfFile[]> {
  const url = `${HF_API}/models/${repoId}/tree/main?recursive=true`;
  const response = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'This repo is gated or private. Accept its licence on huggingface.co and add a read token in Settings.',
    );
  }
  if (!response.ok) throw new Error(`Could not list files (HTTP ${response.status}).`);

  const data = (await response.json()) as Array<{
    path: string;
    size?: number;
    type: string;
    lfs?: { size?: number };
  }>;

  return data
    .filter((f) => f.type === 'file' && isWeightFile(f.path))
    .map((f) => ({
      path: f.path,
      // LFS files report their real size under `lfs`; `size` is the pointer.
      size: f.lfs?.size ?? f.size ?? 0,
      quantization: parseQuantization(f.path),
      isShardIndex: /-00001-of-\d+\.gguf$/i.test(f.path),
    }))
    .sort((a, b) => a.size - b.size);
}

function isWeightFile(filePath: string): boolean {
  return /\.(gguf|safetensors|bin|pt)$/i.test(filePath);
}

/** Extracts "Q4_K_M" / "IQ3_XS" / "F16" from a GGUF filename. */
export function parseQuantization(filename: string): string | undefined {
  const match = filename.match(/[.-](IQ\d[A-Z_]*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)\b/i);
  return match?.[1]?.toUpperCase();
}

export interface DownloadRequest {
  repoId: string;
  filename: string;
  /** Register as a LoRA adapter rather than a base model. */
  asAdapter?: boolean;
  baseModelId?: string;
  displayName?: string;
}

/**
 * Starts a download and returns immediately with the row tracking it.
 *
 * The transfer itself is deliberately not awaited: the caller is an HTTP
 * request that must not stay open for the hour a 30GB file can take. Progress
 * lands in the database, which the models page polls.
 */
export async function startDownload(request: DownloadRequest): Promise<{ id: string }> {
  const db = getDb();
  const now = Date.now();
  const targetDir = path.join(dataDir(), request.asAdapter ? 'adapters' : 'models');
  const localPath = path.join(targetDir, request.repoId.replace('/', '__'), request.filename);

  // Size up front so the progress bar is meaningful from the first byte.
  let totalBytes = 0;
  try {
    const files = await listHfFiles(request.repoId);
    totalBytes = files.find((f) => f.path === request.filename)?.size ?? 0;
  } catch {
    // Non-fatal: the Content-Length header will fill this in.
  }

  const displayName =
    request.displayName ?? `${request.repoId.split('/').pop()} ${parseQuantization(request.filename) ?? ''}`.trim();

  if (request.asAdapter) {
    const row = db
      .insert(adapters)
      .values({
        id: createId('lora'),
        name: displayName,
        baseModelId: request.baseModelId ?? null,
        hfRepoId: request.repoId,
        hfFilename: request.filename,
        localPath,
        status: 'downloading',
        totalBytes,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    void runDownload(row.id, request, localPath, true);
    return { id: row.id };
  }

  const row = db
    .insert(models)
    .values({
      id: createId('model'),
      // llama.cpp is served the file itself, so the bare filename is the handle.
      name: request.filename.replace(/\.gguf$/i, ''),
      displayName,
      provider: 'llamacpp',
      source: 'huggingface',
      hfRepoId: request.repoId,
      hfFilename: request.filename,
      localPath,
      quantization: parseQuantization(request.filename),
      status: 'downloading',
      totalBytes,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  void runDownload(row.id, request, localPath, false);
  return { id: row.id };
}

/**
 * Streams a file to disk, resuming a partial download when one exists.
 *
 * Writes to a `.part` file and renames on success, so an interrupted transfer
 * can never be mistaken for a complete model.
 */
async function runDownload(
  rowId: string,
  request: DownloadRequest,
  localPath: string,
  isAdapter: boolean,
): Promise<void> {
  const db = getDb();
  const table = isAdapter ? adapters : models;
  const partPath = `${localPath}.part`;

  const update = (patch: Record<string, unknown>) => {
    db.update(table as never)
      .set({ ...patch, updatedAt: Date.now() } as never)
      .where(eq((table as typeof models).id, rowId))
      .run();
  };

  try {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });

    // Resume from wherever a previous attempt stopped.
    let resumeFrom = 0;
    try {
      resumeFrom = (await fsp.stat(partPath)).size;
    } catch {
      /* no partial file — start from zero */
    }

    const url = `${HF_RESOLVE}/${request.repoId}/resolve/main/${request.filename}`;
    const headers: Record<string, string> = { ...authHeaders() };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    const response = await fetch(url, { headers, redirect: 'follow' });

    if (response.status === 416) {
      // The range is past the end: the part file is already complete.
      await fsp.rename(partPath, localPath);
      update({ status: 'ready', downloadedBytes: resumeFrom, totalBytes: resumeFrom });
      return;
    }

    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'Access denied. Accept the model licence on huggingface.co and add a read token in Settings.'
          : `Download failed with HTTP ${response.status}.`,
      );
    }

    if (!response.body) throw new Error('Empty response body.');

    // A server that ignored our Range header restarts the file from zero.
    const restarted = resumeFrom > 0 && response.status !== 206;
    if (restarted) resumeFrom = 0;

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    const totalBytes = resumeFrom + contentLength;
    update({ totalBytes, downloadedBytes: resumeFrom, status: 'downloading' });

    let downloaded = resumeFrom;
    let lastReport = Date.now();

    // Progress is written at most twice a second: a 20GB file produces hundreds
    // of thousands of chunks, and one UPDATE each would hammer the database for
    // no visible benefit.
    const progress = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        downloaded += chunk.byteLength;
        if (Date.now() - lastReport > 500) {
          lastReport = Date.now();
          update({ downloadedBytes: downloaded });
        }
        controller.enqueue(chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(progress) as never),
      fs.createWriteStream(partPath, { flags: restarted || resumeFrom === 0 ? 'w' : 'a' }),
    );

    await fsp.rename(partPath, localPath);

    const finalSize = (await fsp.stat(localPath)).size;
    update({
      status: 'ready',
      downloadedBytes: finalSize,
      totalBytes: finalSize,
      sizeBytes: finalSize,
      statusMessage: null,
    });

    db.insert(activity)
      .values({
        id: createId('act'),
        type: 'model.downloaded',
        title: request.displayName ?? request.filename,
        detail: request.repoId,
        entityId: rowId,
        createdAt: Date.now(),
      })
      .run();
  } catch (error) {
    update({
      status: 'error',
      statusMessage: error instanceof Error ? error.message : 'Download failed.',
    });
  }
}

/** Removes a downloaded file and its registry row. */
export async function deleteDownload(rowId: string, isAdapter = false): Promise<void> {
  const db = getDb();
  const table = isAdapter ? adapters : models;

  const row = db
    .select()
    .from(table as typeof models)
    .where(eq((table as typeof models).id, rowId))
    .get();

  if (row?.localPath) {
    await fsp.rm(row.localPath, { force: true }).catch(() => {});
    await fsp.rm(`${row.localPath}.part`, { force: true }).catch(() => {});

    // Clean up the repo directory if this was the last file in it.
    const parent = path.dirname(row.localPath);
    try {
      const remaining = await fsp.readdir(parent);
      if (remaining.length === 0) await fsp.rmdir(parent);
    } catch {
      /* directory already gone or not empty */
    }
  }

  db.delete(table as never)
    .where(eq((table as typeof models).id, rowId))
    .run();
}

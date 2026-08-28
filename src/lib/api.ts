/**
 * API route helpers.
 *
 * Every route funnels through `handle`, so error shape, status mapping and
 * logging are defined once. Routes stay short enough to read at a glance.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';

import { ProviderError } from '@/lib/llm/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what = 'Resource') => new ApiError(`${what} not found.`, 404);

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/**
 * Wraps a handler with uniform error handling.
 *
 * Unexpected errors are logged server-side and reported to the client with
 * their message — this is a single-user local app, so hiding the real cause
 * would only make the user's own machine harder to debug.
 */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return json(await fn());
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, hint: error.hint }, { status: error.status });
    }

    if (error instanceof ZodError) {
      return json(
        {
          error: 'Invalid request.',
          issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        { status: 422 },
      );
    }

    if (error instanceof ProviderError) {
      // 502: the failure is upstream, in a model backend we proxy to.
      return json({ error: error.message, hint: error.hint }, { status: 502 });
    }

    console.error('[forge] unhandled route error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Something went wrong.' },
      { status: 500 },
    );
  }
}

/** Parses and validates a JSON body. */
export async function parseBody<S extends ZodType>(
  request: Request,
  schema: S,
): Promise<import('zod').infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError('Request body must be valid JSON.', 400);
  }
  return schema.parse(raw);
}

/** Reads query-string params with the same validation pipeline. */
export function parseQuery<S extends ZodType>(
  request: Request,
  schema: S,
): import('zod').infer<S> {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) raw[key] = value;
  return schema.parse(raw);
}

/** Coerces a query-string flag; `?archived` with no value means true. */
export function boolParam(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === '' || value === 'true' || value === '1';
}

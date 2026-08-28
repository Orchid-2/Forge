/**
 * Tool registry.
 *
 * Resolves the set of tools available for a turn from three sources — built-ins,
 * user-defined HTTP tools and MCP servers — and executes them uniformly. The
 * chat pipeline only ever talks to this module.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { customTools, type CustomTool } from '@/db/schema';
import { getMcpTools } from '@/lib/mcp/client';
import { getSettings } from '@/lib/settings';
import { BUILTIN_TOOLS } from './builtin';
import type { JsonSchema, Tool, ToolContext, ToolResult } from './types';

/** Every tool the app knows about right now. */
export function allTools(): Tool[] {
  const settings = getSettings();
  if (!settings.toolsEnabled) return [];
  return [...BUILTIN_TOOLS, ...customHttpTools(), ...getMcpTools()];
}

/**
 * The tools a given profile may use.
 *
 * An empty `enabledTools` means the persona has no tools — which is a real
 * choice (Muse is deliberately toolless), not a missing configuration, so it is
 * never treated as "enable everything".
 */
export function toolsForProfile(enabledNames: string[] | null | undefined): Tool[] {
  if (!enabledNames || enabledNames.length === 0) return [];
  const available = new Map(allTools().map((tool) => [tool.name, tool]));

  return enabledNames
    .map((name) => available.get(name))
    .filter((tool): tool is Tool => tool !== undefined);
}

export function findTool(name: string): Tool | undefined {
  return allTools().find((tool) => tool.name === name);
}

/**
 * Executes a tool call, converting any failure into an error *result*.
 *
 * The model needs to see that a tool failed so it can adapt; throwing would
 * abort the turn and leave the user with nothing.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult & { durationMs: number }> {
  const started = Date.now();
  const tool = findTool(name);

  if (!tool) {
    return {
      content: `Unknown tool "${name}". Available tools: ${allTools().map((t) => t.name).join(', ')}`,
      error: 'unknown tool',
      durationMs: Date.now() - started,
    };
  }

  try {
    const result = await tool.execute(args, context);
    return { ...result, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed.';
    return { content: `Tool "${name}" failed: ${message}`, error: message, durationMs: Date.now() - started };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * User-defined HTTP tools
 * ──────────────────────────────────────────────────────────────────────────── */

function customHttpTools(): Tool[] {
  const db = getDb();
  const rows = db.select().from(customTools).where(eq(customTools.enabled, true)).all();
  return rows.map(toHttpTool);
}

function toHttpTool(row: CustomTool): Tool {
  return {
    name: row.name,
    description: row.description,
    category: 'custom',
    runningLabel: `Running ${row.name}`,
    requiresNetwork: true,
    parameters: (row.parameters as JsonSchema) ?? { type: 'object', properties: {} },
    async execute(args, context): Promise<ToolResult> {
      try {
        // Placeholders may appear in the URL, the headers or the body, so the
        // same substitution runs over all three.
        const url = interpolate(row.url, args);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        for (const [key, value] of Object.entries(row.headers ?? {})) {
          headers[key] = interpolate(value, args);
        }

        const method = row.method.toUpperCase();
        const hasBody = !['GET', 'HEAD'].includes(method);

        const response = await fetch(url, {
          method,
          headers,
          body: hasBody
            ? row.bodyTemplate
              ? interpolate(row.bodyTemplate, args)
              : JSON.stringify(args)
            : undefined,
          signal: context.signal ?? AbortSignal.timeout(30_000),
        });

        const text = await response.text();

        if (!response.ok) {
          return {
            content: `${row.name} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
            error: `HTTP ${response.status}`,
          };
        }

        return { content: text.slice(0, 20_000), data: { status: response.status } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Request failed.';
        return { content: `${row.name} failed: ${message}`, error: message };
      }
    },
  };
}

/**
 * Fills `{{name}}` placeholders from the call arguments.
 *
 * Values are JSON-encoded when substituted into a body template so a string
 * containing a quote cannot break the surrounding JSON, and URL-encoded when
 * substituted into a URL.
 */
function interpolate(template: string, args: Record<string, unknown>): string {
  const isUrl = /^https?:\/\//i.test(template);

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
      return undefined;
    }, args);

    if (value === undefined || value === null) return '';
    if (isUrl) return encodeURIComponent(String(value));
    if (typeof value === 'string') return JSON.stringify(value).slice(1, -1);
    return String(value);
  });
}

export * from './types';
export { BUILTIN_TOOLS } from './builtin';

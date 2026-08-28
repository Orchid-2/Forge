/**
 * MCP (Model Context Protocol) client manager.
 *
 * Connections are expensive — a stdio server means spawning a process — so they
 * are pooled on `globalThis` and reused across requests, with a lazy reconnect
 * when a server drops. Tool discovery results are cached in the database so the
 * profile editor can list a server's tools without waking it up.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb } from '@/db';
import { mcpServers, type McpServer, type McpToolSummary } from '@/db/schema';
import type { Tool, ToolResult } from '@/lib/tools/types';
import type { JsonSchema } from '@/lib/llm/types';

/** Namespace separator between server id and tool name: `mcp__<server>__<tool>`. */
const NAMESPACE = '__';
export const MCP_PREFIX = 'mcp';

interface Connection {
  client: import('@modelcontextprotocol/sdk/client/index.js').Client;
  close: () => Promise<void>;
  connectedAt: number;
}

const globalForMcp = globalThis as unknown as { __forgeMcp?: Map<string, Connection> };

function pool(): Map<string, Connection> {
  return (globalForMcp.__forgeMcp ??= new Map());
}

/**
 * Opens (or reuses) a connection to one MCP server.
 *
 * The SDK is imported dynamically so its stdio transport — which pulls in
 * `node:child_process` — never ends up in a bundle that might be evaluated in
 * an edge or client context.
 */
async function connect(server: McpServer): Promise<Connection> {
  const existing = pool().get(server.id);
  if (existing) return existing;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

  const client = new Client({ name: 'forge', version: '0.1.0' }, { capabilities: {} });

  let transport;

  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('stdio MCP server has no command configured.');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      // Inherit PATH and friends so `npx`/`uvx` resolve, then layer the
      // server's own environment on top.
      env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
    });
  } else if (server.transport === 'sse') {
    if (!server.url) throw new Error('SSE MCP server has no URL configured.');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    transport = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    });
  } else {
    if (!server.url) throw new Error('HTTP MCP server has no URL configured.');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    });
  }

  await client.connect(transport);

  const connection: Connection = {
    client,
    close: async () => {
      try {
        await client.close();
      } finally {
        pool().delete(server.id);
      }
    },
    connectedAt: Date.now(),
  };

  pool().set(server.id, connection);
  return connection;
}

export async function disconnectServer(serverId: string): Promise<void> {
  await pool().get(serverId)?.close();
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...pool().values()].map((c) => c.close().catch(() => {})));
}

export interface McpConnectResult {
  ok: boolean;
  tools: McpToolSummary[];
  error?: string;
}

/**
 * Connects, lists tools and records the outcome on the server row.
 *
 * Used both by the "Test connection" button and lazily whenever a chat turn
 * needs a server that is not yet connected.
 */
export async function refreshServer(serverId: string): Promise<McpConnectResult> {
  const db = getDb();
  const server = db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).get();
  if (!server) return { ok: false, tools: [], error: 'Server not found.' };

  db.update(mcpServers)
    .set({ status: 'connecting', updatedAt: Date.now() })
    .where(eq(mcpServers.id, serverId))
    .run();

  try {
    const { client } = await connect(server);
    const listed = await client.listTools();

    const tools: McpToolSummary[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));

    db.update(mcpServers)
      .set({
        status: 'connected',
        discoveredTools: tools,
        lastError: null,
        lastConnectedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(mcpServers.id, serverId))
      .run();

    return { ok: true, tools };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';

    // Drop the half-open connection so the next attempt starts clean.
    await disconnectServer(serverId).catch(() => {});

    db.update(mcpServers)
      .set({ status: 'error', lastError: message, updatedAt: Date.now() })
      .where(eq(mcpServers.id, serverId))
      .run();

    return { ok: false, tools: [], error: message };
  }
}

/**
 * All tools from all enabled MCP servers, adapted to Forge's `Tool` interface.
 *
 * Reads the cached tool list rather than connecting: this runs on every chat
 * turn, and waking a stdio server just to enumerate tools would add seconds of
 * latency to each message. The connection happens on first *call*.
 */
export function getMcpTools(): Tool[] {
  const db = getDb();
  const servers = db.select().from(mcpServers).where(eq(mcpServers.enabled, true)).all();

  const tools: Tool[] = [];

  for (const server of servers) {
    for (const discovered of server.discoveredTools ?? []) {
      tools.push({
        name: qualifiedName(server.id, discovered.name),
        description: discovered.description ?? `${discovered.name} (via ${server.name})`,
        category: 'mcp',
        runningLabel: `Running ${discovered.name}`,
        requiresNetwork: server.transport !== 'stdio',
        parameters: normalizeSchema(discovered.inputSchema),
        async execute(args): Promise<ToolResult> {
          return callMcpTool(server.id, discovered.name, args);
        },
      });
    }
  }

  return tools;
}

/**
 * Tool names must survive a round trip through the model, so they are
 * restricted to `[a-zA-Z0-9_-]` — our ids contain characters that some
 * backends reject in a function name.
 */
export function qualifiedName(serverId: string, toolName: string): string {
  return `${MCP_PREFIX}${NAMESPACE}${serverId.replace(/[^a-zA-Z0-9_-]/g, '')}${NAMESPACE}${toolName}`;
}

export function parseQualifiedName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith(`${MCP_PREFIX}${NAMESPACE}`)) return null;
  const rest = name.slice(MCP_PREFIX.length + NAMESPACE.length);
  const separator = rest.indexOf(NAMESPACE);
  if (separator === -1) return null;
  return { serverId: rest.slice(0, separator), toolName: rest.slice(separator + NAMESPACE.length) };
}

async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const db = getDb();

  // The sanitised id in the tool name may not match the stored id exactly, so
  // resolve by comparing sanitised forms.
  const server =
    db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).get() ??
    db
      .select()
      .from(mcpServers)
      .all()
      .find((s) => s.id.replace(/[^a-zA-Z0-9_-]/g, '') === serverId);

  if (!server) return { content: 'MCP server not found.', error: 'not found' };

  try {
    const { client } = await connect(server);
    const response = await client.callTool({ name: toolName, arguments: args });

    const blocks = Array.isArray(response.content) ? response.content : [];
    const text = blocks
      .map((block: unknown) => {
        const item = block as { type?: string; text?: string; resource?: { text?: string } };
        if (item.type === 'text') return item.text ?? '';
        if (item.type === 'resource') return item.resource?.text ?? '';
        // Images and other binary blocks cannot go into a text transcript.
        return `[${item.type ?? 'content'}]`;
      })
      .filter(Boolean)
      .join('\n');

    if (response.isError) {
      return { content: text || 'The tool reported an error.', error: text };
    }

    return { content: text || 'Tool returned no content.', data: response.structuredContent };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool call failed.';

    // A dead pooled connection is the usual cause; drop it so the next call
    // reconnects rather than failing forever.
    await disconnectServer(server.id).catch(() => {});

    db.update(mcpServers)
      .set({ status: 'error', lastError: message, updatedAt: Date.now() })
      .where(eq(mcpServers.id, server.id))
      .run();

    return { content: `MCP tool failed: ${message}`, error: message };
  }
}

/** MCP schemas are already JSON Schema, but may omit the fields we rely on. */
function normalizeSchema(schema: Record<string, unknown> | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  return {
    type: 'object',
    properties: (schema.properties as Record<string, unknown>) ?? {},
    required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
  };
}

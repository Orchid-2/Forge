/**
 * Tool system types.
 *
 * A tool is a named function the model can call. Built-in tools, user-defined
 * HTTP tools and MCP-provided tools all normalise to this shape, so the chat
 * loop has exactly one code path for executing any of them.
 */
import type { JsonSchema, ToolSpec } from '@/lib/llm/types';

export type { ToolSpec, JsonSchema };

export interface ToolContext {
  conversationId?: string;
  projectId?: string | null;
  profileId?: string | null;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text handed back to the model as the tool-result turn. */
  content: string;
  /** Structured payload for rendering a rich result card in the UI. */
  data?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Grouping for the profile editor's tool picker. */
  category: 'search' | 'memory' | 'utility' | 'vault' | 'custom' | 'mcp';
  /** Shown in the tool-call card while it runs, e.g. "Searching the web". */
  runningLabel: string;
  /**
   * Tools that reach the network or the filesystem are marked so the UI can
   * flag them and offline mode can hide them.
   */
  requiresNetwork?: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function toSpec(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

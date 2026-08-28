/**
 * Prompt-based tool calling for models without a native tool template.
 *
 * Most abliterated and community fine-tunes strip or break the tool-calling
 * chat template, so passing `tools` to the backend silently does nothing. This
 * module is the fallback: describe the tools in the system prompt, then parse
 * the model's `<tool_call>` blocks out of the token stream.
 *
 * Streaming makes this non-trivial — a tag can be split across chunks — so the
 * parser is a small state machine that buffers only as much as it must and
 * releases everything else to the UI immediately.
 */
import { createId } from '@/lib/ids';
import type { ToolCall, ToolSpec } from './types';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

/** The instruction block appended to the system prompt when in fallback mode. */
export function buildToolInstructions(tools: ToolSpec[]): string {
  if (tools.length === 0) return '';

  const specs = tools
    .map((tool) => {
      const params = JSON.stringify(tool.parameters);
      return `- ${tool.name}: ${tool.description}\n  parameters: ${params}`;
    })
    .join('\n');

  return [
    '',
    '# Tools',
    '',
    'You can call tools. Available tools:',
    specs,
    '',
    'To call a tool, emit exactly this, and nothing else in the same turn:',
    `${OPEN_TAG}{"name": "tool_name", "arguments": {"key": "value"}}${CLOSE_TAG}`,
    '',
    'Rules:',
    '- One JSON object per tool_call block. Emit several blocks to call several tools.',
    '- Use a tool only when it genuinely helps; answer directly otherwise.',
    '- After the tool result arrives, answer the user in plain prose. Do not repeat the block.',
  ].join('\n');
}

export interface ParseResult {
  /** Text safe to show the user right now. */
  text: string;
  /** Any complete tool calls found in this chunk. */
  calls: ToolCall[];
}

/**
 * Incremental parser: feed it stream deltas, get back display text and calls.
 *
 * The buffering rule is the subtle part. When the tail of the buffer could be
 * the start of `<tool_call>`, we hold it back rather than flushing — otherwise
 * a literal `<tool` flickers into the UI a frame before it becomes a tag.
 */
export class PromptedToolParser {
  private buffer = '';
  private insideCall = false;

  push(delta: string): ParseResult {
    this.buffer += delta;
    const calls: ToolCall[] = [];
    let text = '';

    while (this.buffer.length > 0) {
      if (this.insideCall) {
        const closeIndex = this.buffer.indexOf(CLOSE_TAG);
        if (closeIndex === -1) return { text, calls }; // wait for more input

        const payload = this.buffer.slice(0, closeIndex);
        this.buffer = this.buffer.slice(closeIndex + CLOSE_TAG.length);
        this.insideCall = false;

        const call = parseCall(payload);
        if (call) calls.push(call);
        continue;
      }

      const openIndex = this.buffer.indexOf(OPEN_TAG);
      if (openIndex !== -1) {
        text += this.buffer.slice(0, openIndex);
        this.buffer = this.buffer.slice(openIndex + OPEN_TAG.length);
        this.insideCall = true;
        continue;
      }

      // No complete tag. Release everything except a possible partial tag tail.
      const held = partialTagLength(this.buffer, OPEN_TAG);
      text += this.buffer.slice(0, this.buffer.length - held);
      this.buffer = this.buffer.slice(this.buffer.length - held);
      break;
    }

    return { text, calls };
  }

  /** Flushes whatever is left when the stream ends. */
  finish(): ParseResult {
    const calls: ToolCall[] = [];
    let text = '';

    if (this.insideCall) {
      // Model got cut off mid-call; try to salvage it, otherwise drop it rather
      // than showing the user a half-written JSON blob.
      const call = parseCall(this.buffer);
      if (call) calls.push(call);
    } else {
      text = this.buffer;
    }

    this.buffer = '';
    this.insideCall = false;
    return { text, calls };
  }
}

/** Length of the suffix of `text` that is a proper prefix of `tag`. */
function partialTagLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

function parseCall(payload: string): ToolCall | null {
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(payload.slice(start, end + 1)) as {
      name?: string;
      tool?: string;
      arguments?: unknown;
      parameters?: unknown;
      args?: unknown;
    };

    // Models disagree on the key names; accept the common variants.
    const name = parsed.name ?? parsed.tool;
    if (!name || typeof name !== 'string') return null;

    const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
    const args =
      typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as Record<string, unknown>) : rawArgs;

    return {
      id: createId('call'),
      name,
      arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
    };
  } catch {
    return null;
  }
}

/**
 * Heuristic: does this model have a working native tool template?
 *
 * Ollama answers authoritatively via `/api/show` capabilities, but that costs a
 * round trip per turn. This name check is the fast path, and a wrong guess is
 * cheap — the fallback works for every model, it just spends prompt tokens.
 */
export function likelySupportsNativeTools(modelName: string): boolean {
  const name = modelName.toLowerCase();

  // Abliterated / uncensored fine-tunes almost always lose the tool template.
  if (/abliterat|uncensor|unalign|dolphin|orthogonal|amoral/.test(name)) return false;

  return /llama-?3|llama3|qwen|mistral|mixtral|command-?r|firefunction|hermes|functionary|granite|nemotron|gpt-oss|glm/.test(
    name,
  );
}

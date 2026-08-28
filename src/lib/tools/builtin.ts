/**
 * Built-in tools.
 *
 * Each one returns text shaped for a model to read — numbered, compact, with
 * the useful part first — plus structured `data` the UI renders as a result
 * card. Tools never throw: a thrown error would abort the whole turn, whereas
 * an error *result* lets the model recover or explain itself.
 */
import 'server-only';

import { getSettings } from '@/lib/settings';
import { createMemory, retrieveMemories, markAccessed } from '@/lib/memory';
import { fetchPageText, webSearch, type SearchResult } from './web-search';
import type { Tool } from './types';

const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web for current information. Use for anything time-sensitive, ' +
    'recent, or outside your training data. Returns titles, URLs and snippets.',
  category: 'search',
  runningLabel: 'Searching the web',
  requiresNetwork: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query. Be specific.' },
      limit: {
        type: 'number',
        description: 'How many results to return (1-10). Default 5.',
      },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const query = String(args.query ?? '').trim();
    if (!query) return { content: 'No query provided.', error: 'missing query' };

    try {
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const results = await webSearch(query, { limit, signal: context.signal });

      if (results.length === 0) {
        return { content: `No results found for "${query}".`, data: { query, results: [] } };
      }

      const content = results
        .map(
          (r: SearchResult, i) =>
            `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`,
        )
        .join('\n\n');

      return {
        content: `Search results for "${query}":\n\n${content}`,
        data: { query, results },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed.';
      return { content: `Search failed: ${message}`, error: message };
    }
  },
};

const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description:
    'Fetch a web page and read its text content. Use after web_search when a ' +
    'snippet is not enough, or when the user gives you a URL directly.',
  category: 'search',
  runningLabel: 'Reading page',
  requiresNetwork: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full http(s) URL to fetch.' },
    },
    required: ['url'],
  },
  async execute(args, context) {
    const url = String(args.url ?? '').trim();
    if (!url) return { content: 'No URL provided.', error: 'missing url' };

    try {
      const page = await fetchPageText(url, { signal: context.signal });
      return {
        content: `# ${page.title}\nSource: ${page.url}\n\n${page.text}`,
        data: { url: page.url, title: page.title, chars: page.text.length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fetch failed.';
      return { content: `Could not fetch ${url}: ${message}`, error: message };
    }
  },
};

const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    'Search your long-term memory about this user. Use when the conversation ' +
    'references something from the past, or when you need context about who ' +
    'they are, what they work on, or what they prefer.',
  category: 'memory',
  runningLabel: 'Recalling',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are trying to remember.' },
      limit: { type: 'number', description: 'Maximum memories to return. Default 8.' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const query = String(args.query ?? '').trim();
    if (!query) return { content: 'No query provided.', error: 'missing query' };

    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
    const found = await retrieveMemories(query, {
      projectId: context.projectId,
      topK: limit,
      // A lower floor than prompt-injection uses: the model asked explicitly,
      // so a weak-but-relevant hit is better than nothing.
      minScore: 0.15,
    });

    if (found.length === 0) {
      return { content: `Nothing in memory about "${query}".`, data: { query, memories: [] } };
    }

    markAccessed(found.map((f) => f.memory.id));

    const content = found
      .map((f, i) => `[${i + 1}] (${f.memory.kind}) ${f.memory.content}`)
      .join('\n');

    return {
      content: `Memories about "${query}":\n${content}`,
      data: {
        query,
        memories: found.map((f) => ({
          id: f.memory.id,
          content: f.memory.content,
          kind: f.memory.kind,
          score: Number(f.score.toFixed(3)),
        })),
      },
    };
  },
};

const memoryWriteTool: Tool = {
  name: 'memory_write',
  description:
    'Save something to long-term memory. Only for durable facts about the user ' +
    'that will still matter weeks from now — not conversation details, not what ' +
    'was discussed, and never your own output.',
  category: 'memory',
  runningLabel: 'Remembering',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'A standalone sentence, understandable with no context. ' +
          'Third person about the user.',
      },
      kind: {
        type: 'string',
        enum: ['fact', 'preference', 'event', 'entity', 'instruction', 'insight'],
        description: 'What sort of memory this is.',
      },
      importance: { type: 'number', description: '0.0 to 1.0. Default 0.6.' },
    },
    required: ['content'],
  },
  async execute(args, context) {
    const content = String(args.content ?? '').trim();
    if (content.length < 10) {
      return { content: 'Memory content too short to be useful.', error: 'too short' };
    }

    if (!getSettings().memoryEnabled) {
      return { content: 'Memory is disabled in settings; nothing was saved.' };
    }

    try {
      const { memory, deduplicated } = await createMemory({
        content,
        kind: (args.kind as never) ?? 'fact',
        importance: Number(args.importance) || 0.6,
        source: 'auto',
        sourceConversationId: context.conversationId ?? null,
        projectId: context.projectId ?? null,
        profileId: context.profileId ?? null,
      });

      return {
        content: deduplicated
          ? 'Already remembered something equivalent; reinforced it instead.'
          : `Saved to memory: ${memory.content}`,
        data: { id: memory.id, content: memory.content, deduplicated },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save memory.';
      return { content: message, error: message };
    }
  },
};

const currentTimeTool: Tool = {
  name: 'current_time',
  description:
    "Get the current date and time. Models have no clock, so use this before " +
    'any reasoning that depends on today, ages, deadlines or elapsed time.',
  category: 'utility',
  runningLabel: 'Checking the time',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const now = new Date();
    return {
      content: [
        `Current date and time: ${now.toLocaleString(undefined, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        `ISO 8601: ${now.toISOString()}`,
        `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      ].join('\n'),
      data: { iso: now.toISOString(), timestamp: now.getTime() },
    };
  },
};

const calculateTool: Tool = {
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression exactly. Use it rather than doing ' +
    'multi-digit arithmetic yourself, which language models do unreliably.',
  category: 'utility',
  runningLabel: 'Calculating',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          'e.g. "(1920 * 1080) / 2" or "2^16". Supports + - * / % ^ ( ) and ' +
          'sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil, min, max, pi, e.',
      },
    },
    required: ['expression'],
  },
  async execute(args) {
    const expression = String(args.expression ?? '').trim();
    try {
      const value = evaluateExpression(expression);
      return {
        content: `${expression} = ${value}`,
        data: { expression, result: value },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid expression.';
      return { content: `Could not evaluate "${expression}": ${message}`, error: message };
    }
  },
};

/**
 * Arithmetic evaluator.
 *
 * A recursive-descent parser rather than `eval` or `new Function`: the input
 * comes from a language model, and handing model output to a JS evaluator is
 * arbitrary code execution on the user's machine. This parser can only ever
 * produce a number.
 */
export function evaluateExpression(input: string): number {
  const tokens = tokenize(input);
  let position = 0;

  const peek = () => tokens[position];
  const consume = () => tokens[position++];

  // expression := term (('+' | '-') term)*
  function parseExpression(): number {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = parseTerm();
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }

  // term := factor (('*' | '/' | '%') factor)*
  function parseTerm(): number {
    let left = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = consume();
      const right = parseFactor();
      if ((operator === '/' || operator === '%') && right === 0) {
        throw new Error('division by zero');
      }
      left = operator === '*' ? left * right : operator === '/' ? left / right : left % right;
    }
    return left;
  }

  // factor := unary ('^' factor)?   — right-associative, as exponentiation is.
  function parseFactor(): number {
    const base = parseUnary();
    if (peek() === '^') {
      consume();
      return Math.pow(base, parseFactor());
    }
    return base;
  }

  function parseUnary(): number {
    if (peek() === '-') {
      consume();
      return -parseUnary();
    }
    if (peek() === '+') {
      consume();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const token = consume();
    if (token === undefined) throw new Error('unexpected end of expression');

    if (token === '(') {
      const value = parseExpression();
      if (consume() !== ')') throw new Error('unbalanced parentheses');
      return value;
    }

    if (/^\d/.test(token)) return Number(token);

    const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
    if (token in constants) return constants[token];

    const functions: Record<string, (...args: number[]) => number> = {
      sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
      ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      log: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max,
    };

    if (token in functions) {
      if (consume() !== '(') throw new Error(`${token} must be followed by (`);
      const args = [parseExpression()];
      while (peek() === ',') {
        consume();
        args.push(parseExpression());
      }
      if (consume() !== ')') throw new Error('unbalanced parentheses');
      return functions[token](...args);
    }

    throw new Error(`unknown token "${token}"`);
  }

  const result = parseExpression();
  if (position < tokens.length) throw new Error(`unexpected "${tokens[position]}"`);
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');

  // Kill floating-point dust like 0.30000000000000004 without losing precision
  // on values that genuinely need it.
  return Number(result.toPrecision(15));
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|[a-zA-Z]+|\*\*|[+\-*/%^(),])/y;
  let index = 0;

  while (index < input.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(input);
    if (!match) throw new Error(`unexpected character at position ${index}`);
    // Accept `**` as an alias for `^`, since models emit both.
    tokens.push(match[1] === '**' ? '^' : match[1].toLowerCase());
    index = pattern.lastIndex;
  }

  return tokens;
}

export const BUILTIN_TOOLS: Tool[] = [
  webSearchTool,
  fetchUrlTool,
  memorySearchTool,
  memoryWriteTool,
  currentTimeTool,
  calculateTool,
];

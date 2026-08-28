/**
 * Mock Ollama backend for testing the chat pipeline without real weights.
 *
 * Speaks enough of Ollama's API to exercise streaming, native tool calling and
 * embeddings: /api/version, /api/tags, /api/show, /api/chat, /api/embed.
 *
 *   node scripts/mock-ollama.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 11499);

const MODELS = [
  {
    // Name matches Forge's native-tool heuristic, so `tools` is sent natively.
    name: 'qwen-mock:8b',
    model: 'qwen-mock:8b',
    modified_at: new Date().toISOString(),
    size: 4_800_000_000,
    details: { family: 'qwen', parameter_size: '8B', quantization_level: 'Q4_K_M' },
  },
  {
    // "abliterated" trips the heuristic the other way, forcing the prompted
    // tool-calling fallback — the path most community fine-tunes need.
    name: 'mock-abliterated:8b',
    model: 'mock-abliterated:8b',
    modified_at: new Date().toISOString(),
    size: 4_800_000_000,
    details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' },
  },
  {
    name: 'mock-chat:8b',
    model: 'mock-chat:8b',
    modified_at: new Date().toISOString(),
    size: 4_800_000_000,
    details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' },
  },
  {
    name: 'nomic-embed-text:latest',
    model: 'nomic-embed-text:latest',
    modified_at: new Date().toISOString(),
    size: 274_000_000,
    details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' },
  },
];

/** Deterministic pseudo-embedding so similarity is stable across runs. */
function fakeEmbedding(text, dim = 64) {
  const vector = new Array(dim).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vector[(h >>> 0) % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (payload, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/api/version') return json({ version: '0.0.0-mock' });
  if (url.pathname === '/api/tags') return json({ models: MODELS });

  if (url.pathname === '/api/show') {
    const body = await readBody(req);
    return json({
      capabilities: body.model?.includes('embed') ? ['embedding'] : ['completion', 'tools'],
      details: MODELS.find((m) => m.name === body.model)?.details ?? {},
      model_info: { 'llama.context_length': 8192 },
    });
  }

  if (url.pathname === '/api/embed') {
    const body = await readBody(req);
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    return json({ embeddings: inputs.map((t) => fakeEmbedding(String(t))) });
  }

  if (url.pathname === '/api/chat') {
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';
    const alreadyRanTool = (body.messages ?? []).some((m) => m.role === 'tool');

    // Tool-call path: if tools were offered and the prompt asks for a
    // calculation, request the tool on the first pass and answer on the second.
    if (body.tools?.length && /calculate|multiply|\d+\s*[*x]\s*\d+/i.test(prompt) && !alreadyRanTool) {
      send({
        model: body.model,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'calculate', arguments: { expression: '1920 * 1080' } } }],
        },
        done: false,
      });
      send({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 42, eval_count: 8 });
      return res.end();
    }

    // Prompted-tools path: Forge did not send `tools`, but injected a tool
    // spec into the system prompt. Emit the block split across chunks, which is
    // the case a naive parser gets wrong.
    const systemPrompt = body.messages?.[0]?.content ?? '';
    if (!body.tools?.length && /# Tools/.test(systemPrompt) && /calculate|multiply/i.test(prompt) && !alreadyRanTool) {
      const parts = [
        'Let me work that out. <tool',
        '_call>{"name": "calc',
        'ulate", "arguments": {"expression": "1920 * 1080"}}</tool',
        '_call>',
      ];
      for (const part of parts) {
        send({ model: body.model, message: { role: 'assistant', content: part }, done: false });
      }
      send({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 50, eval_count: 12 });
      return res.end();
    }

    // Title requests must come back short, or the pipeline rejects them.
    if (/write a title/i.test(body.messages?.[0]?.content ?? '')) {
      send({ model: body.model, message: { role: 'assistant', content: 'Screen Pixel Math' }, done: false });
      send({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 20, eval_count: 4 });
      return res.end();
    }

    // Memory extraction must return a JSON array.
    if (/extract durable/i.test(body.messages?.[0]?.content ?? '')) {
      const payload = '[{"content":"Marcus works with 1920x1080 displays.","kind":"fact","importance":0.4,"tags":["display"]}]';
      send({ model: body.model, message: { role: 'assistant', content: payload }, done: false });
      send({ model: body.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 30, eval_count: 20 });
      return res.end();
    }

    const reply = alreadyRanTool
      ? 'A 1920x1080 display has **2,073,600** pixels.\n\n```js\nconst pixels = 1920 * 1080;\n```\n'
      : `You said: "${prompt}". Here is a **markdown** reply with \`inline code\`.\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n`;

    // Stream word by word, as a real model would.
    let index = 0;
    const words = reply.match(/\S+\s*/g) ?? [reply];
    const timer = setInterval(() => {
      if (index >= words.length) {
        clearInterval(timer);
        send({
          model: body.model,
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 120,
          eval_count: words.length,
        });
        return res.end();
      }
      send({ model: body.model, message: { role: 'assistant', content: words[index++] }, done: false });
    }, 4);
    return;
  }

  json({ error: `mock: unhandled ${url.pathname}` }, 404);
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock ollama on http://127.0.0.1:${PORT}`));

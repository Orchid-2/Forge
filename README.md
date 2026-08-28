# Forge

A local-first personal AI workspace: deep conversations, long-term memory, and
knowledge management. Built for local models — and tuned for the uncensored and
abliterated fine-tunes that most chat UIs handle badly.

Everything lives in one SQLite file on your machine. No account, no telemetry,
no cloud round-trip. Once a model is downloaded, it works with the network off.

```bash
pnpm install && pnpm dev
```

That is the whole setup. The database is created, migrated and seeded on first
request.

---

## What it does

**Chat** — streaming responses, Markdown with syntax-highlighted code, editing
any message, regenerating with version history (`‹ 2/3 ›`), and pinning the
turns worth keeping.

**Personas** — six ship by default (Forge, Research, Engineer, Unfiltered, Muse,
Mirror). Each bundles a system prompt with its own sampling parameters, model
and tool access, so switching modes is one click rather than a re-typed prompt.
The sampling is tuned per persona: Research runs at 0.35 because a cited answer
should be reproducible; Muse runs at 1.05 because range matters more than
determinism.

**Memory** — conversations are mined in the background for durable facts, which
are de-duplicated, embedded, and retrieved into later prompts. Every recalled
memory is cited under the reply that used it, so you can always answer "why did
it know that?". Browse, edit, pin and delete them from the Memory page.

**Projects** — group related chats under shared instructions, a default model,
and a scoped memory pool that does not leak into unrelated conversations.

**Dashboard** — activity, token use, memory growth over time, which models you
actually use, and customisable progress trackers (counters, streaks, targets).

**Models** — pull from Ollama by name, or browse Hugging Face and download GGUF
weights and LoRA adapters directly, with resumable transfers.

**Integrations** — mirror everything into an Obsidian vault as linked Markdown,
and back it up to a private Hugging Face dataset.

**Tools** — web search, page fetching, memory read/write, a clock, and exact
arithmetic. Extend with MCP servers or your own HTTP endpoints.

---

## Running it on Kaggle

No local GPU? `notebooks/forge-on-kaggle.ipynb` runs Forge on a free Kaggle T4 and
exposes it through a Cloudflare tunnel. Upload it to
[kaggle.com/code](https://www.kaggle.com/code), enable Internet and GPU in the session
options, and run the cells top to bottom.

Worth knowing: Kaggle sessions end after 9–12 hours, the tunnel URL is public while it
runs, and your conversations live on Kaggle's infrastructure rather than yours — which
is the opposite of the point. Good for trying it out or running a model bigger than your
laptop holds; not where to keep anything you care about. The notebook checkpoints the
database on exit so you can download it and drop it into a local install later.

## Requirements

- **Node.js 20.11+** and **pnpm**
- A model backend — any one of:
  - [Ollama](https://ollama.com) (recommended): `ollama serve`
  - llama.cpp: `llama-server -m model.gguf --port 8080`
  - Anything OpenAI-compatible: vLLM, LM Studio, TGI, text-generation-webui

First run, from nothing:

```bash
ollama pull llama3.1:8b        # a chat model
ollama pull nomic-embed-text   # embeddings for memory (optional but recommended)
pnpm install
pnpm dev                       # http://localhost:3000
```

Forge discovers whatever is running and picks a sensible default model. If no
embedding model is installed it falls back to a local lexical embedder — memory
still works offline with zero setup, it just matches shared words rather than
meaning. Install one later and hit **Re-embed** on the Memory page to upgrade
everything captured in the meantime.

---

## Configuration

Everything is configurable from **Settings** in the app, which writes to the
database. A `.env.local` (copy `.env.example`) can seed the same values, and is
only consulted for keys you have never set in the UI.

Secrets — Hugging Face and search API tokens — are stored in the local SQLite
file and are never sent to the browser. The settings API returns a mask, and
saving that mask back is a no-op, so a form round-trip cannot destroy a working
token.

---

## Working with abliterated and uncensored models

Community fine-tunes usually strip or break the chat template's tool-calling
support, so passing a tool schema to the backend silently does nothing. Forge
detects this by model name and falls back to **prompt-based tool calling**:
the tool spec goes into the system prompt, and a streaming state machine parses
`<tool_call>` blocks out of the token stream — correctly, even when a tag is
split across chunk boundaries.

The result is that tools work on models that have no tool support at all.

The **Unfiltered** persona is written to match: no hedging, no disclaimers, no
"as an AI". It drops the performance of caution without dropping accuracy.

---

## Architecture

```
src/
├── app/
│   ├── (app)/                  workspace shell: sidebar + routed pages
│   │   ├── chat/[id]           conversation
│   │   ├── projects/[id]       project workspace
│   │   ├── memory              memory browser
│   │   ├── dashboard           activity, charts, progress
│   │   ├── models              registry + Hugging Face browser
│   │   ├── profiles            persona editor
│   │   └── settings            everything configurable
│   └── api/                    28 route handlers
├── components/
│   ├── ui/                     Radix-based primitives
│   ├── chat/                   transcript, composer, tool cards, markdown
│   ├── layout/                 shell, sidebar, page chrome
│   └── command/                ⌘K palette
├── db/
│   ├── schema.ts               single source of truth (16 tables)
│   ├── migrate.ts              auto-applied migrations + FTS5 triggers
│   └── seed.ts                 default personas and settings
├── lib/
│   ├── llm/                    provider abstraction + prompted-tool fallback
│   ├── memory/                 embeddings, hybrid retrieval, extraction
│   ├── chat/                   prompt assembly, context packing, turn pipeline
│   ├── tools/                  built-ins, registry, custom HTTP tools
│   ├── mcp/                    pooled MCP client
│   ├── models/                 registry + resumable HF downloads
│   └── integrations/           Obsidian, Hugging Face
└── store/                      Zustand: app state, chat streaming
```

### Notable decisions

**No vector database.** A personal knowledge base is thousands of memories, not
millions. A brute-force scan of 10k × 384-dim normalised vectors is a few
million multiply-adds — under 5ms in plain JS, and exact where an ANN index only
approximates. Adding ChromaDB or LanceDB would mean a second process to run, a
second thing to back up, and a consistency problem between the two. Vectors are
stored as `BLOB`s beside their text, so the whole app is one SQLite file. The
swap-in point, if it ever needs to scale past ~100k memories, is one function.

**Hybrid retrieval.** Cosine similarity finds paraphrases; embeddings are
famously weak on exact names, numbers and identifiers. SQLite's FTS5 covers
those. The two scores are blended after rank-normalising BM25, since raw BM25 is
unbounded and cannot be mixed with a cosine score directly.

**Streaming is frame-batched.** A fast local model emits hundreds of deltas per
second. Deltas accumulate into a buffer and flush on `requestAnimationFrame`, so
React re-renders once per frame instead of once per token, and `MessageItem` is
memoised with an explicit comparator so settled turns never re-parse their
Markdown.

**Layered prompts.** The system prompt is assembled most-general to
most-specific: who you are → persona → project → conversation override →
retrieved memories → rolling summary. Later layers win, which is what lets a
project override a persona and one conversation override both.

**Rolling compression.** Rather than silently dropping the oldest turns when a
conversation outgrows the context window, older turns fold into a summary that
is regenerated incrementally — so cost stays constant however long the
conversation runs.

**No `eval` on model output.** The `calculate` tool is a recursive-descent
parser. Handing a language model's output to a JS evaluator is arbitrary code
execution on your machine.

---

## Development

```bash
pnpm dev          # dev server
pnpm build        # production build
pnpm typecheck    # tsc --noEmit
pnpm lint
pnpm db:generate  # regenerate migrations after editing schema.ts
pnpm db:studio    # browse the database

node scripts/smoke.mjs         # database, FTS5, embeddings, regressions
node scripts/mock-ollama.mjs   # fake backend for testing without weights
```

`scripts/mock-ollama.mjs` speaks enough of Ollama's API to exercise the whole
pipeline — streaming, native tool calls, the prompted fallback, embeddings —
with no model downloaded. Point `ollamaBaseUrl` at it and everything works.

### Data

All state lives in `./data/` — database, downloaded models, caches. It is
gitignored. Delete it to factory reset.

---

## Tech

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · Radix UI ·
Zustand · Framer Motion · Drizzle ORM · better-sqlite3 · Recharts

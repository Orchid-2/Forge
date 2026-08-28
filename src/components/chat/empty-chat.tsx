'use client';

import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';

import type { Profile } from '@/db/schema';
import type { ProjectWithCounts } from '@/lib/client/api';
import { cn } from '@/lib/utils';

/**
 * The blank-conversation state.
 *
 * Rather than a generic greeting, this shows what the *current persona* is
 * actually tuned for, with starters written for that persona. The screen
 * teaches the feature that makes the app worth using.
 */
export function EmptyChat({
  profile,
  project,
  onPrompt,
  disabled,
}: {
  profile?: Profile;
  project?: ProjectWithCounts;
  onPrompt: (prompt: string) => void;
  disabled?: boolean;
}) {
  const starters = startersFor(profile?.name);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center py-12">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-2xl text-center"
      >
        <div className="relative mx-auto mb-5 w-fit">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 blur-3xl"
            style={{
              background: `radial-gradient(circle at center, hsl(${profile?.accent ?? '22 94% 56%'} / 0.28), transparent 70%)`,
            }}
          />
          <span
            className="flex size-14 items-center justify-center rounded-2xl border border-border bg-elevated text-2xl shadow-raised"
            style={{ color: `hsl(${profile?.accent ?? '22 94% 56%'})` }}
          >
            {profile?.icon ?? '◆'}
          </span>
        </div>

        <h2 className="text-xl font-semibold tracking-tight">
          {project ? project.name : (profile?.name ?? 'Forge')}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          {project?.description ??
            profile?.description ??
            'A local-first workspace for long conversations and long memory.'}
        </p>

        {starters.length > 0 ? (
          <div className="mt-8 grid gap-2 sm:grid-cols-2">
            {starters.map((starter) => (
              <button
                key={starter}
                disabled={disabled}
                onClick={() => onPrompt(starter)}
                className={cn(
                  'group flex items-start gap-2 rounded-lg border border-border/70 bg-elevated/40 px-3.5 py-3 text-left text-sm',
                  'transition-all duration-150 ease-swift hover:border-border hover:bg-elevated hover:shadow-subtle',
                  'disabled:pointer-events-none disabled:opacity-50',
                )}
              >
                <span className="flex-1 leading-snug text-foreground/85">{starter}</span>
                <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}

/**
 * Starters written per persona.
 *
 * They are deliberately specific: a generic "How can I help?" teaches nothing,
 * whereas these show what each mode is actually good at.
 */
function startersFor(personaName?: string): string[] {
  switch (personaName) {
    case 'Research':
      return [
        'What does the current evidence actually say about creatine and cognition?',
        'Compare SQLite, DuckDB and Postgres for a single-user analytics app.',
        'Find and summarise what changed in the EU AI Act this year.',
        'What are the strongest arguments against my plan to self-host everything?',
      ];
    case 'Engineer':
      return [
        'Review this function and tell me what breaks under concurrency.',
        'Design a schema for a habit tracker with streaks and retroactive edits.',
        "Why is my Postgres query slow? Here's the EXPLAIN output.",
        'Walk me through implementing vector search without a vector database.',
      ];
    case 'Unfiltered':
      return [
        'Give me your honest read on what I described, no hedging.',
        'What am I avoiding thinking about here?',
        'Argue the opposite of what I just said, properly.',
        'Tell me what most people get wrong about this.',
      ];
    case 'Muse':
      return [
        'Write the opening paragraph of a story that starts at the end.',
        'Give me three genuinely different angles on this idea.',
        'Rewrite this so it sounds like a person wrote it.',
        'What is the most interesting thing about an ordinary Tuesday?',
      ];
    case 'Mirror':
      return [
        'What patterns have you noticed in what I bring to you?',
        'I keep starting things and not finishing them. Ask me the right question.',
        'Reflect back what you actually heard me say this week.',
        "What have I told you that I seem to have stopped believing?",
      ];
    default:
      return [
        'Explain something you think I have wrong about how memory works.',
        'Help me think through a decision I keep postponing.',
        'What should I know about running local models on consumer hardware?',
        'Summarise what you remember about me so far.',
      ];
  }
}

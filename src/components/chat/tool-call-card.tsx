'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronRight,
  Clock,
  Globe,
  Hammer,
  Loader2,
  Search,
  Terminal,
} from 'lucide-react';

import type { StreamedToolCall } from '@/lib/chat/protocol';
import { cn, truncate } from '@/lib/utils';

/**
 * A tool invocation, rendered inline in the transcript.
 *
 * Collapsed by default: the model's *answer* is what the user came for, and a
 * wall of raw tool output between paragraphs buries it. The header carries
 * enough (name, key argument, duration) to make expanding a considered choice.
 */
export function ToolCallCard({ call }: { call: StreamedToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = iconFor(call.name);

  const running = call.status === 'running';
  const failed = call.status === 'error';

  return (
    <div
      className={cn(
        'my-2.5 overflow-hidden rounded-lg border text-sm transition-colors',
        failed ? 'border-destructive/35 bg-destructive/[0.04]' : 'border-border bg-elevated/50',
      )}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md',
            failed
              ? 'bg-destructive/12 text-destructive'
              : running
                ? 'bg-primary/12 text-primary'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium">{prettyName(call.name)}</span>
            {primaryArgument(call) ? (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {truncate(primaryArgument(call)!, 64)}
              </span>
            ) : null}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
          {failed ? (
            <AlertCircle className="size-3.5 text-destructive" />
          ) : running ? (
            <span className="animate-pulse">running</span>
          ) : (
            <>
              {call.durationMs ? (
                <span className="flex items-center gap-1 tabular-nums">
                  <Clock className="size-3" />
                  {formatDuration(call.durationMs)}
                </span>
              ) : null}
              <Check className="size-3.5 text-success" />
            </>
          )}
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-200', expanded && 'rotate-90')}
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="space-y-3 px-3 py-2.5">
              {Object.keys(call.arguments ?? {}).length > 0 ? (
                <Section label="Arguments">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {JSON.stringify(call.arguments, null, 2)}
                  </pre>
                </Section>
              ) : null}

              {call.error ? (
                <Section label="Error">
                  <p className="text-xs leading-relaxed text-destructive">{call.error}</p>
                </Section>
              ) : call.result ? (
                <Section label="Result">
                  <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {call.result}
                  </pre>
                </Section>
              ) : running ? (
                <p className="text-xs text-muted-foreground">Waiting for the tool to finish…</p>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      {children}
    </div>
  );
}

function iconFor(name: string) {
  if (name.startsWith('mcp__')) return Terminal;
  if (name.includes('search') && name.includes('memory')) return Brain;
  if (name.includes('memory')) return Brain;
  if (name.includes('search')) return Search;
  if (name.includes('fetch') || name.includes('url')) return Globe;
  return Hammer;
}

/** `mcp__server__read_file` → "read file"; `web_search` → "web search". */
function prettyName(name: string): string {
  const bare = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  return bare.replace(/[_-]+/g, ' ');
}

/**
 * The one argument worth showing in a collapsed header.
 *
 * Preferring the common names before falling back to "first string" keeps the
 * header meaningful for built-ins while still doing something sensible for an
 * arbitrary MCP tool.
 */
function primaryArgument(call: StreamedToolCall): string | null {
  const args = call.arguments ?? {};
  for (const key of ['query', 'url', 'expression', 'path', 'content', 'q']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }

  const firstString = Object.values(args).find((v) => typeof v === 'string' && v);
  return typeof firstString === 'string' ? firstString : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

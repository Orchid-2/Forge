'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import type { CitedMemory } from '@/lib/chat/protocol';
import { cn } from '@/lib/utils';

/**
 * Memories injected into a turn's prompt.
 *
 * Shown so the user can always answer "why did it know that?" — an opaque
 * memory system is one people stop trusting. Collapsed by default; the count
 * alone is usually enough.
 */
export function MemoryCitations({ memories }: { memories: CitedMemory[] }) {
  const [open, setOpen] = useState(false);

  if (memories.length === 0) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <Brain className="size-3" />
        <span>
          Recalled {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
        </span>
        <ChevronRight
          className={cn('size-3 transition-transform duration-200', open && 'rotate-90')}
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="mt-1.5 space-y-1 overflow-hidden"
          >
            {memories.map((memory) => (
              <li
                key={memory.id}
                className="flex items-start gap-2 rounded-md border border-border/60 bg-elevated/40 px-2.5 py-2"
              >
                <Badge variant="muted" className="mt-0.5 shrink-0">
                  {memory.kind}
                </Badge>
                <Link
                  href={`/memory?highlight=${memory.id}`}
                  className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground transition-colors hover:text-foreground"
                >
                  {memory.content}
                </Link>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/60">
                  {memory.score.toFixed(2)}
                </span>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

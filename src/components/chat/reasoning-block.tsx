'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A reasoning model's scratchpad.
 *
 * Kept visually subordinate to the answer — dimmer, smaller, collapsed once the
 * answer arrives. It is context for the curious, not the deliverable.
 */
export function ReasoningBlock({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  // Open while thinking so there is something to watch; the user can close it.
  const [open, setOpen] = useState(Boolean(streaming));

  if (!content.trim()) return null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/25">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/30"
      >
        <Brain className={cn('size-3.5', streaming && 'animate-pulse text-primary')} />
        <span className="font-medium">{streaming ? 'Thinking…' : 'Thought process'}</span>
        <ChevronRight
          className={cn('ml-auto size-3.5 transition-transform duration-200', open && 'rotate-90')}
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-border/50"
          >
            <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {content}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

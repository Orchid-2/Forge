'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import type { Message, StoredToolCall } from '@/db/schema';
import type { CitedMemory, StreamedToolCall } from '@/lib/chat/protocol';
import { cn, formatCompact } from '@/lib/utils';
import { Markdown } from './markdown';
import { MemoryCitations } from './memory-citations';
import { ReasoningBlock } from './reasoning-block';
import { ToolCallCard } from './tool-call-card';

export interface MessageItemProps {
  message: Message;
  /** Live text while this message is the one streaming. */
  streamingContent?: string;
  streamingReasoning?: string;
  streamingToolCalls?: StreamedToolCall[];
  streamingMemories?: CitedMemory[];
  isStreaming?: boolean;
  showStats?: boolean;
  personaName?: string;
  personaIcon?: string;
  personaAccent?: string;
  onEdit?: (id: string, content: string) => void;
  onRegenerate?: (id: string) => void;
  onDelete?: (id: string, cascade: boolean) => void;
  onTogglePin?: (id: string) => void;
  onSwitchVersion?: (id: string, version: number) => void;
}

/**
 * One turn in the transcript.
 *
 * Memoised with an explicit comparator: during streaming the list re-renders on
 * every frame, and without this every settled message would re-run its Markdown
 * parse each time. The comparator deliberately ignores callback identity, which
 * the parent recreates on each render.
 */
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  const {
    message,
    streamingContent,
    streamingReasoning,
    streamingToolCalls,
    streamingMemories,
    isStreaming,
    showStats,
    personaName,
    personaIcon,
    personaAccent,
    onEdit,
    onRegenerate,
    onDelete,
    onTogglePin,
    onSwitchVersion,
  } = props;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isUser = message.role === 'user';
  const content = isStreaming ? (streamingContent ?? '') : message.content;
  const reasoning = isStreaming ? streamingReasoning : (message.reasoning ?? '');
  const toolCalls: Array<StreamedToolCall | StoredToolCall> = isStreaming
    ? (streamingToolCalls ?? [])
    : (message.toolCalls ?? []);

  useEffect(() => {
    if (editing) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        // Put the caret at the end rather than selecting everything, so a small
        // correction does not require repositioning first.
        el.setSelectionRange(el.value.length, el.value.length);
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }
    }
  }, [editing]);

  // Tool and system turns are rendered inside their assistant message, never
  // standalone. This bails out *after* every hook has run — an early return
  // above them would change the hook order between renders.
  if (message.role === 'tool' || message.role === 'system') return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable outside a secure context */
    }
  };

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() && draft !== message.content) onEdit?.(message.id, draft.trim());
    else setDraft(message.content);
  };

  const tokensPerSecond =
    message.durationMs > 0 && message.completionTokens > 0
      ? (message.completionTokens / (message.durationMs / 1000)).toFixed(1)
      : null;

  /* ── User turn ─────────────────────────────────────────────────────────── */
  if (isUser) {
    return (
      <div id={message.id} className="group/msg flex flex-col items-end gap-1.5 py-3">
        {editing ? (
          <div className="w-full max-w-[85%] space-y-2">
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === 'Escape') {
                  setDraft(message.content);
                  setEditing(false);
                }
              }}
              className="max-h-[50vh] resize-none"
            />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-2xs text-muted-foreground">
                Editing rewrites this message and regenerates everything after it.
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={commitEdit}>
                Save &amp; resend
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'max-w-[85%] rounded-2xl rounded-tr-md border border-border/60 bg-elevated px-4 py-2.5',
                'text-[0.9375rem] leading-[1.65] shadow-subtle',
                message.pinned && 'border-primary/40 ring-1 ring-primary/15',
              )}
            >
              {message.pinned ? (
                <Pin className="mb-1 inline size-3 -translate-y-px text-primary" />
              ) : null}
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
            </div>

            <MessageActions className="pr-1">
              <ActionButton label="Copy" onClick={copy}>
                {copied ? <Check className="text-success" /> : <Copy />}
              </ActionButton>
              <ActionButton label="Edit" onClick={() => setEditing(true)}>
                <Pencil />
              </ActionButton>
              <ActionButton
                label={message.pinned ? 'Unpin' : 'Pin'}
                onClick={() => onTogglePin?.(message.id)}
              >
                {message.pinned ? <PinOff /> : <Pin />}
              </ActionButton>
              <ActionButton
                label="Delete from here"
                destructive
                onClick={() => onDelete?.(message.id, true)}
              >
                <Trash2 />
              </ActionButton>
            </MessageActions>
          </>
        )}
      </div>
    );
  }

  /* ── Assistant turn ────────────────────────────────────────────────────── */
  const memories = isStreaming ? streamingMemories : undefined;

  return (
    <div id={message.id} className="group/msg py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="flex size-5 items-center justify-center rounded text-xs"
          style={{ color: personaAccent ? `hsl(${personaAccent})` : undefined }}
        >
          {personaIcon ?? '◆'}
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          {personaName ?? 'Assistant'}
        </span>
        {message.pinned ? <Pin className="size-3 text-primary" /> : null}
        {message.model && showStats ? (
          <Badge variant="muted" className="font-mono">
            {message.model}
          </Badge>
        ) : null}
      </div>

      <div className="pl-7">
        {memories && memories.length > 0 ? <MemoryCitations memories={memories} /> : null}

        {reasoning ? <ReasoningBlock content={reasoning} streaming={isStreaming} /> : null}

        {toolCalls.map((call) => (
          <ToolCallCard
            key={call.id}
            call={
              'status' in call
                ? (call as StreamedToolCall)
                : {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    status: call.error ? 'error' : 'done',
                    result: call.result,
                    error: call.error,
                    durationMs: call.durationMs,
                  }
            }
          />
        ))}

        {editing ? (
          <div className="space-y-2">
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === 'Escape') {
                  setDraft(message.content);
                  setEditing(false);
                }
              }}
              className="min-h-[10rem] resize-y font-mono text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={commitEdit}>
                Save
              </Button>
            </div>
          </div>
        ) : content ? (
          <Markdown
            content={content}
            // The caret marks the live edge of the stream; without it a slow
            // model is indistinguishable from a stalled one.
            className={cn(isStreaming && 'streaming-caret')}
          />
        ) : isStreaming ? (
          <ThinkingIndicator />
        ) : null}

        {message.error ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-destructive">{message.error}</p>
              <button
                onClick={() => onRegenerate?.(message.id)}
                className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {!isStreaming && !editing ? (
          <MessageActions className="mt-1">
            {message.versionCount > 1 && onSwitchVersion ? (
              <div className="mr-1 flex items-center gap-0.5 rounded-md border border-border/60 px-1">
                <button
                  disabled={message.activeVersion === 0}
                  onClick={() => onSwitchVersion(message.id, message.activeVersion - 1)}
                  className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                  aria-label="Previous version"
                >
                  <ChevronLeft className="size-3" />
                </button>
                <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                  {message.activeVersion + 1}/{message.versionCount}
                </span>
                <button
                  disabled={message.activeVersion >= message.versionCount - 1}
                  onClick={() => onSwitchVersion(message.id, message.activeVersion + 1)}
                  className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                  aria-label="Next version"
                >
                  <ChevronRight className="size-3" />
                </button>
              </div>
            ) : null}

            <ActionButton label="Copy" onClick={copy}>
              {copied ? <Check className="text-success" /> : <Copy />}
            </ActionButton>
            <ActionButton label="Regenerate" onClick={() => onRegenerate?.(message.id)}>
              <RefreshCw />
            </ActionButton>
            <ActionButton label="Edit" onClick={() => setEditing(true)}>
              <Pencil />
            </ActionButton>
            <ActionButton
              label={message.pinned ? 'Unpin' : 'Pin'}
              onClick={() => onTogglePin?.(message.id)}
            >
              {message.pinned ? <PinOff /> : <Pin />}
            </ActionButton>
            <ActionButton label="Delete" destructive onClick={() => onDelete?.(message.id, false)}>
              <Trash2 />
            </ActionButton>

            {showStats && message.completionTokens > 0 ? (
              <span className="ml-1 font-mono text-2xs tabular-nums text-muted-foreground/70">
                {formatCompact(message.completionTokens)} tok
                {tokensPerSecond ? ` · ${tokensPerSecond}/s` : ''}
                {message.citedMemoryIds?.length ? (
                  <>
                    {' · '}
                    <Brain className="inline size-2.5 -translate-y-px" />{' '}
                    {message.citedMemoryIds.length}
                  </>
                ) : null}
              </span>
            ) : null}
          </MessageActions>
        ) : null}
      </div>
    </div>
  );
}, areEqual);

/**
 * Re-render only when something visible changed.
 *
 * Streaming props are compared by value, but only for the one message that is
 * actually streaming — for every other row `isStreaming` is false on both
 * sides and the comparison short-circuits.
 */
function areEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  if (prev.message !== next.message) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.showStats !== next.showStats) return false;
  if (prev.personaName !== next.personaName) return false;

  if (next.isStreaming) {
    if (prev.streamingContent !== next.streamingContent) return false;
    if (prev.streamingReasoning !== next.streamingReasoning) return false;
    if (prev.streamingToolCalls !== next.streamingToolCalls) return false;
    if (prev.streamingMemories !== next.streamingMemories) return false;
  }

  return true;
}

function MessageActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 transition-opacity duration-150',
        'opacity-0 focus-within:opacity-100 group-hover/msg:opacity-100',
        className,
      )}
    >
      {children}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick?: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} delay={500}>
      <button
        onClick={onClick}
        aria-label={label}
        className={cn(
          'rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5',
          destructive && 'hover:bg-destructive/10 hover:text-destructive',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Shown between "request sent" and "first token", where nothing else exists. */
function ThinkingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-1.5 py-1"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1.5 rounded-full bg-muted-foreground/50"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.16 }}
        />
      ))}
    </motion.div>
  );
}

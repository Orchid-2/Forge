'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn, estimateTokensClient, isMac } from '@/lib/client/format';
import { useAppStore } from '@/store/app-store';

const MAX_HEIGHT_PX = 320;

/**
 * Message composer.
 *
 * Auto-grows to fit its content up to a cap, then scrolls. The height is set in
 * a layout effect rather than on change so the resize lands in the same frame
 * as the text — measuring after paint makes the box visibly lag the caret.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  autoFocus = true,
  children,
}: {
  onSend: (content: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Controls rendered above the input row — model and persona switchers. */
  children?: React.ReactNode;
}) {
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  const showTokenStats = useAppStore((s) => s.settings.showTokenStats);

  const [value, setValue] = useState('');
  const [mac, setMac] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setMac(isMac()), []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [value]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = useCallback(() => {
    const content = value.trim();
    if (!content || busy || disabled) return;
    setValue('');
    onSend(content);
  }, [value, busy, disabled, onSend]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl+Enter always sends, regardless of the Enter preference — it is the
    // one shortcut people carry between apps.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && sendOnEnter) {
      event.preventDefault();
      submit();
    }
  };

  const tokenEstimate = value ? estimateTokensClient(value) : 0;

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        {children ? <div className="mb-2 flex items-center gap-2">{children}</div> : null}

        <div
          className={cn(
            'relative rounded-xl border border-border bg-elevated shadow-raised transition-colors',
            'focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/15',
            disabled && 'opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={placeholder ?? 'Send a message…'}
            className={cn(
              'block w-full resize-none bg-transparent px-4 py-3.5 pr-14 text-[0.9375rem] leading-[1.6]',
              'outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed',
            )}
          />

          <div className="absolute bottom-2.5 right-2.5">
            {busy ? (
              <Tooltip label="Stop generating" kbd="Esc">
                <Button size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop">
                  <Square className="size-3 fill-current" />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip label="Send" kbd={sendOnEnter ? 'Enter' : mac ? '⌘↵' : 'Ctrl ↵'}>
                <Button
                  size="icon-sm"
                  onClick={submit}
                  disabled={!value.trim() || disabled}
                  aria-label="Send message"
                >
                  <ArrowUp />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex h-4 items-center justify-between px-1 text-2xs text-muted-foreground">
          <span>
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                Generating — press Esc to stop
              </span>
            ) : (
              <span className="opacity-70">
                {sendOnEnter ? 'Enter to send · Shift+Enter for a new line' : `${mac ? '⌘' : 'Ctrl'}+Enter to send`}
              </span>
            )}
          </span>

          {showTokenStats && tokenEstimate > 0 ? (
            <span className="font-mono tabular-nums opacity-70">~{tokenEstimate} tokens</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

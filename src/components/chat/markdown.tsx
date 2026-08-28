'use client';

import { memo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, WrapText } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Markdown renderer for chat messages.
 *
 * Memoised on `content`: during streaming the parent re-renders every frame,
 * and re-parsing the whole Markdown tree each time is by far the most expensive
 * thing in the transcript. With this memo, only the message actually receiving
 * tokens does any parsing work.
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn('prose-forge', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `ignoreMissing` keeps an unknown language from throwing mid-stream,
        // and `detect` handles fences with no language tag at all.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          code: CodeRenderer,
          pre: PreRenderer,
          a: LinkRenderer,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * `pre` is passed through untouched because `CodeRenderer` builds the whole
 * block — header, scroller and all. Rendering the default `pre` around it would
 * nest two scroll containers.
 */
function PreRenderer({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

interface CodeProps extends ComponentPropsWithoutRef<'code'> {
  className?: string;
  children?: ReactNode;
}

function CodeRenderer({ className, children, ...props }: CodeProps) {
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  const text = extractText(children);

  // Inline code: no language class and no newline. Styled by `.prose-forge`.
  if (!language && !text.includes('\n')) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return <CodeBlock language={language} code={text} highlighted={children} className={className} />;
}

function CodeBlock({
  language,
  code,
  highlighted,
  className,
}: {
  language?: string;
  code: string;
  highlighted: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is unavailable outside a secure context; the code is still
      // selectable, so failing quietly is the right call.
    }
  };

  const lineCount = code.split('\n').length;

  return (
    <div className="group/code my-4 overflow-hidden rounded-lg border border-border bg-[hsl(var(--chrome))]">
      <div className="flex items-center justify-between border-b border-border/70 bg-elevated/40 px-3 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          {language ?? 'text'}
        </span>

        <div className="flex items-center gap-0.5">
          {lineCount > 3 ? (
            <button
              onClick={() => setWrap((v) => !v)}
              className={cn(
                'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                wrap && 'text-primary',
              )}
              title={wrap ? 'Disable wrapping' : 'Wrap long lines'}
            >
              <WrapText className="size-3.5" />
            </button>
          ) : null}

          <button
            onClick={copy}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Copy code"
          >
            {copied ? (
              <>
                <Check className="size-3.5 text-success" />
                Copied
              </>
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </div>
      </div>

      <pre
        className={cn(
          'overflow-x-auto p-3.5 text-[0.8125rem] leading-[1.6]',
          wrap && 'whitespace-pre-wrap break-words',
        )}
      >
        <code className={cn('font-mono', className)}>{highlighted}</code>
      </pre>
    </div>
  );
}

/** External links open in a new tab; in-app anchors stay in place. */
function LinkRenderer({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  const external = href?.startsWith('http');
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * Flattens a highlighted React tree back to plain text for the copy button.
 *
 * rehype-highlight replaces the raw string with nested `<span>`s, so the
 * original source is only recoverable by walking the children.
 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');

  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }

  return '';
}

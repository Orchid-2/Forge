import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Empty state.
 *
 * The glyph sits in a soft radial glow rather than a hard-edged circle, so an
 * empty screen reads as deliberate rather than broken.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-16 text-center animate-fade-in',
        className,
      )}
    >
      {icon ? (
        <div className="relative mb-5">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 blur-2xl"
            style={{
              background:
                'radial-gradient(circle at center, hsl(var(--primary) / 0.18), transparent 70%)',
            }}
          />
          <div className="flex size-14 items-center justify-center rounded-2xl border border-border/70 bg-elevated text-muted-foreground shadow-subtle [&_svg]:size-6">
            {icon}
          </div>
        </div>
      ) : null}

      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

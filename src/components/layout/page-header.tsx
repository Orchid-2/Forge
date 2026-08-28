import { cn } from '@/lib/utils';

/** Consistent page chrome: title bar plus a scrollable body. */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Rendered under the title row — filters, tabs, search. */
  children?: React.ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-border">
      <div className="flex h-12 items-center gap-3 px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      {description ? (
        <p className="-mt-1 px-5 pb-3 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      {children ? <div className="px-5 pb-3">{children}</div> : null}
    </header>
  );
}

export function PageBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('mx-auto w-full max-w-5xl px-5 py-6', className)}>{children}</div>
    </div>
  );
}

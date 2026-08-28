import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shimmer rounded-md', className)} {...props} />;
}

/** Placeholder shaped like a chat turn, shown while a conversation loads. */
export function MessageSkeleton() {
  return (
    <div className="space-y-6 px-1 py-6">
      {[0, 1].map((row) => (
        <div key={row} className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[92%]" />
          <Skeleton className="h-4 w-[68%]" />
        </div>
      ))}
    </div>
  );
}

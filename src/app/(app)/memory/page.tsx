import { Suspense } from 'react';
import type { Metadata } from 'next';

import { MemoryView } from '@/components/memory/memory-view';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: 'Memory' };

export default function MemoryPage() {
  return (
    // useSearchParams needs a Suspense boundary to keep the route streamable.
    <Suspense fallback={<Skeleton className="m-5 h-40" />}>
      <MemoryView />
    </Suspense>
  );
}

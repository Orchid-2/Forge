import { CommandPalette } from '@/components/command/command-palette';
import { Sidebar } from '@/components/layout/sidebar';

/**
 * Workspace shell: a fixed sidebar plus a scrollable main region.
 *
 * `h-dvh` with `overflow-hidden` here means each page owns its own scroll
 * container. That is what keeps the chat composer pinned to the bottom while
 * the transcript scrolls independently.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
      <CommandPalette />
    </div>
  );
}

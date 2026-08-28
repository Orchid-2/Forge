'use client';

import { useEffect } from 'react';
import { Toaster } from 'sonner';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/store/app-store';

/**
 * Client-side providers and one-time bootstrap.
 *
 * Data loads here rather than in each page so navigating between Chat, Memory
 * and Dashboard does not refetch the persona and model lists every time.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  const loadAll = useAppStore((s) => s.loadAll);
  const settings = useAppStore((s) => s.settings);
  const ready = useAppStore((s) => s.ready);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Appearance settings live in the database but must be applied to <html>, and
  // mirrored into localStorage so the pre-paint script can use them next load.
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;

    const resolved =
      settings.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : settings.theme;

    root.classList.toggle('light', resolved === 'light');
    root.style.setProperty('--font-scale', String(settings.fontScale));
    root.classList.toggle('reduce-motion', settings.reduceMotion);

    try {
      localStorage.setItem('forge:theme', settings.theme);
      localStorage.setItem('forge:font-scale', String(settings.fontScale));
      localStorage.setItem('forge:reduce-motion', settings.reduceMotion ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }, [ready, settings.theme, settings.fontScale, settings.reduceMotion]);

  // Follow the OS when the user chose "system".
  useEffect(() => {
    if (settings.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => document.documentElement.classList.toggle('light', media.matches);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={250}>
      {children}
      <Toaster
        position="bottom-right"
        // Inherit the app palette instead of sonner's own light/dark themes.
        toastOptions={{
          classNames: {
            toast:
              'group rounded-lg border border-border bg-popover text-popover-foreground shadow-float text-sm',
            description: 'text-muted-foreground',
            actionButton: 'bg-primary text-primary-foreground rounded-md',
            cancelButton: 'bg-muted text-muted-foreground rounded-md',
          },
        }}
      />
    </TooltipProvider>
  );
}

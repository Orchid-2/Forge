import type { Metadata, Viewport } from 'next';

import { AppProviders } from '@/components/layout/app-providers';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Forge',
    template: '%s · Forge',
  },
  description:
    'A local-first personal AI workspace: deep conversations, long-term memory, and knowledge management.',
  // A local tool should never leak its page titles to a search engine.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#111113' },
    { media: '(prefers-color-scheme: light)', color: '#faf9f7' },
  ],
  width: 'device-width',
  initialScale: 1,
  // The composer must not zoom the viewport when focused on a tablet.
  maximumScale: 1,
};

/**
 * Applied before first paint to stop a light flash on load.
 *
 * Next cannot know the stored theme during SSR, so this reads localStorage
 * synchronously in the document head. It is small and deliberately dependency
 * free — it runs before any bundle does.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('forge:theme') || 'dark';
    var resolved = stored === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : stored;
    if (resolved === 'light') document.documentElement.classList.add('light');
    var scale = localStorage.getItem('forge:font-scale');
    if (scale) document.documentElement.style.setProperty('--font-scale', scale);
    if (localStorage.getItem('forge:reduce-motion') === '1') {
      document.documentElement.classList.add('reduce-motion');
    }
  } catch (e) {
    /* storage blocked — dark default already applies */
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh bg-background font-sans">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

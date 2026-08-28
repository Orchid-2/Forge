import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Forge design system.
 *
 * Every colour is declared as an HSL triplet CSS variable in `globals.css` so a
 * theme swap is a variable swap — no Tailwind classes need to change. The palette
 * is a cool graphite base with a warm ember accent (the "forge" in Forge), which
 * keeps the UI feeling like a tool rather than a generic blue-violet AI product.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        /** App chrome: the sidebar / rails that frame the workspace. */
        chrome: {
          DEFAULT: 'hsl(var(--chrome))',
          foreground: 'hsl(var(--chrome-foreground))',
        },
        /** One step above the background — cards, popovers, composer. */
        elevated: 'hsl(var(--elevated))',

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          muted: 'hsl(var(--primary-muted))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        /** Fixed hues for charts so series colours stay stable across themes. */
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // System-first stacks: zero network at build or runtime, which keeps the
        // "works offline" promise intact. Swap in a webfont via next/font if wanted.
        sans: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'JetBrains Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      fontSize: {
        // Slightly tightened tracking at display sizes reads as "designed".
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      },
      boxShadow: {
        subtle: '0 1px 2px 0 rgb(0 0 0 / 0.24)',
        raised: '0 4px 16px -2px rgb(0 0 0 / 0.32), 0 2px 4px -2px rgb(0 0 0 / 0.24)',
        float: '0 16px 48px -12px rgb(0 0 0 / 0.5), 0 4px 12px -4px rgb(0 0 0 / 0.3)',
        ember: '0 0 0 1px hsl(var(--primary) / 0.32), 0 4px 24px -6px hsl(var(--primary) / 0.4)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        /** The blinking block that trails a streaming response. */
        caret: {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0.15' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.24s cubic-bezier(0.16, 1, 0.3, 1)',
        caret: 'caret 1.1s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
      },
      transitionTimingFunction: {
        // A single "expressive" easing curve used across the app for consistency.
        swift: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [animate],
};

export default config;

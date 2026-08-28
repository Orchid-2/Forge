import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // better-sqlite3 and the MCP stdio transport are native/node-only. Keeping them
  // external stops Next from trying to bundle them into the server runtime.
  serverExternalPackages: ['better-sqlite3', '@modelcontextprotocol/sdk'],

  experimental: {
    // Large icon/chart barrels get tree-shaken per-import instead of pulling the
    // whole package into every route that touches one symbol.
    optimizePackageImports: ['lucide-react', 'recharts', 'date-fns'],
  },

  eslint: {
    // Lint is a separate `pnpm lint` step; a lint warning should never block a
    // local build of a personal tool.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

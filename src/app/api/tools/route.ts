/** GET /api/tools — every callable tool, for the persona editor's picker. */
import { allTools } from '@/lib/tools/registry';
import { handle } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({
    // The `execute` function cannot be serialised, so only the metadata goes out.
    tools: allTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      requiresNetwork: tool.requiresNetwork ?? false,
      parameters: tool.parameters,
    })),
  }));
}

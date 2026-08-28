/** GET /api/settings — current settings with secrets masked. PATCH — update. */
import { getPublicSettings, updateSettings } from '@/lib/settings';
import { settingsPatchSchema } from '@/lib/settings-defaults';
import { handle, parseBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => ({ settings: getPublicSettings() }));
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const patch = await parseBody(request, settingsPatchSchema);
    updateSettings(patch);

    // Return the masked view so the client never caches a real token.
    return { settings: getPublicSettings() };
  });
}

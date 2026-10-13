// One shared secret, RELAY_TOKEN, guards both doors:
// - the MCP endpoint: `?key=<token>` in the connector URL (Claude's custom connectors cannot send
//   headers), or `Authorization: Bearer <token>` for other MCP clients;
// - the Blender bridge: `Authorization: Bearer <token>` from the add-on.
// Anyone with the token can run Python inside your Blender. Keep it secret; rotate it if it leaks.
import { timingSafeEqual, createHash } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function authorized(request, { allowQuery }) {
  const secret = process.env.RELAY_TOKEN;
  if (!secret || secret.length < 32) return { ok: false, status: 500, error: 'Server is not set up: RELAY_TOKEN must be at least 32 characters.' };
  let given = null;
  const h = request.headers.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) given = h.slice(7).trim();
  if (!given && allowQuery) given = new URL(request.url).searchParams.get('key');
  if (!given || !timingSafeEqual(digest(given), digest(secret))) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true };
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

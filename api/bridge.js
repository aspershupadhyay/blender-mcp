// The Blender add-on's door (Authorization: Bearer <RELAY_TOKEN>):
//   POST /api/bridge {"action":"next"}                 -> waits up to 20 s for a job: {"job": {...}} or {"job": null}
//   POST /api/bridge {"action":"result","id":..,"result":{..}} -> stores the result for the MCP call
import { authorized, json } from '../lib/auth.js';
import { store } from '../lib/store.js';

const HOLD_MS = 20_000;  // long poll: one request holds up to 20 s
const CHECK_MS = 1_000;  // queue check interval while holding (about 1 Redis command a second)
const MAX_RESULT = 4_000_000; // bytes; screenshots are kept well under this by the add-on

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function POST(request) {
  const a = authorized(request, { allowQuery: false });
  if (!a.ok) return json({ error: a.error }, a.status);
  const raw = await request.text();
  if (raw.length > MAX_RESULT) return json({ error: 'Result too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }
  if (body.action === 'next') {
    await store.markSeen();
    const end = Date.now() + HOLD_MS;
    for (;;) {
      const job = await store.popJob();
      if (job) return json({ job });
      if (Date.now() + CHECK_MS > end) return json({ job: null });
      await sleep(CHECK_MS);
    }
  }
  if (body.action === 'result' && typeof body.id === 'string' && body.result) {
    await store.setResult(body.id, body.result);
    await store.markSeen();
    return json({ ok: true });
  }
  return json({ error: 'Unknown action' }, 400);
}

export function GET() { return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } }); }

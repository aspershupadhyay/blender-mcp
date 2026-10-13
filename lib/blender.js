// Blender's side: pairing (a device code the owner approves on the web page), then the bridge the
// add-on long-polls for jobs. Each paired Blender has its own token, revocable on the dashboard.
import { store } from './store.js';
import { token, sha256, session, csrfOk, json, origin, limited, audit } from './security.js';

const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const userCode = () => { const b = new Uint32Array(8); crypto.getRandomValues(b); const s = [...b].map((x) => ALPHA[x % ALPHA.length]).join(''); return `${s.slice(0, 4)}-${s.slice(4)}`; };
const PAIR_TTL = 600;
const ONLINE_MS = 40_000;

// POST /api/pair/start  { name }  (the add-on)
export async function pairStart(request) {
  if (await limited(request, 'pair-start', 10, 600)) return json({ error: 'Too many pairing attempts. Wait 10 minutes.' }, 429);
  const b = await request.json().catch(() => ({}));
  const device = token(32), code = userCode();
  const rec = { code, name: String(b.name || 'Blender').slice(0, 60), status: 'pending', at: Date.now() };
  await store.set(`bmcp:dc:${sha256(device)}`, JSON.stringify(rec), PAIR_TTL);
  await store.set(`bmcp:uc:${code}`, sha256(device), PAIR_TTL);
  const o = origin(request);
  return json({ device_code: device, user_code: code, verification_uri: `${o}/pair`, verification_uri_complete: `${o}/pair?code=${code}`, interval: 2, expires_in: PAIR_TTL });
}

// POST /api/pair/poll  { device_code }  (the add-on)
export async function pairPoll(request) {
  if (await limited(request, 'pair-poll', 120, 600)) return json({ status: 'slow_down' }, 429);
  const b = await request.json().catch(() => ({}));
  const key = `bmcp:dc:${sha256(b.device_code || '')}`;
  const raw = await store.get(key);
  if (!raw) return json({ status: 'expired' });
  const rec = JSON.parse(raw);
  if (rec.status !== 'approved') return json({ status: rec.status });
  await store.del(key); // the token is handed over exactly once
  return json({ status: 'approved', token: rec.token, name: rec.name });
}

// GET /api/pair/lookup?code=  (the owner's page)
export async function pairLookup(request) {
  const s = await session(request);
  if (!s) return json({ error: 'Sign in first' }, 401);
  if (await limited(request, 'pair-lookup', 20, 600)) return json({ error: 'Too many tries. Wait 10 minutes.' }, 429);
  const code = String(new URL(request.url).searchParams.get('code') || '').toUpperCase().trim();
  const h = await store.get(`bmcp:uc:${code}`);
  const raw = h && (await store.get(`bmcp:dc:${h}`));
  if (!raw) return json({ error: 'No Blender is waiting with that code. Codes last 10 minutes.' }, 404);
  const rec = JSON.parse(raw);
  return json({ code, name: rec.name, status: rec.status, age_s: Math.round((Date.now() - rec.at) / 1000) });
}

// POST /api/pair/approve { code, allow }  (the owner's page, CSRF)
export async function pairApprove(request) {
  const s = await session(request);
  if (!csrfOk(s, request)) return json({ error: 'Session expired. Reload.' }, 403);
  if (await limited(request, 'pair-approve', 20, 600)) return json({ error: 'Too many tries. Wait 10 minutes.' }, 429);
  const b = await request.json().catch(() => ({}));
  const code = String(b.code || '').toUpperCase().trim();
  const h = await store.get(`bmcp:uc:${code}`);
  const raw = h && (await store.get(`bmcp:dc:${h}`));
  if (!raw) return json({ error: 'That code expired. Press Pair again in Blender.' }, 404);
  const rec = JSON.parse(raw);
  if (rec.status !== 'pending') return json({ error: 'Already handled.' }, 409);
  await store.del(`bmcp:uc:${code}`);
  if (!b.allow) {
    await store.set(`bmcp:dc:${h}`, JSON.stringify({ ...rec, status: 'denied' }), 60);
    return json({ ok: true, status: 'denied' });
  }
  const t = `bmb_${token(32)}`, id = token(9);
  const info = { id, name: rec.name, login: s.login, created: Date.now(), last_seen: 0 };
  await store.set(`bmcp:bt:${sha256(t)}`, id);
  await store.set(`bmcp:bridge:${id}`, JSON.stringify(info));
  await store.sadd('bmcp:bridges', id);
  await store.set(`bmcp:dc:${h}`, JSON.stringify({ ...rec, status: 'approved', token: t }), 120);
  await audit('pair', { name: rec.name, login: s.login });
  return json({ ok: true, status: 'approved', name: rec.name });
}

export async function bridgeAuth(request) {
  const h = request.headers.get('authorization') || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  const id = await store.get(`bmcp:bt:${sha256(h.slice(7).trim())}`);
  if (!id) return null;
  const raw = await store.get(`bmcp:bridge:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function seen(b) {
  const now = Date.now();
  await store.set('bmcp:seen', String(now), 3600);
  if (now - (b.last_seen || 0) > 15_000) await store.set(`bmcp:bridge:${b.id}`, JSON.stringify({ ...b, last_seen: now }));
}

export async function online() {
  return Date.now() - Number((await store.get('bmcp:seen')) || 0) < ONLINE_MS;
}

// POST /api/bridge {action:"next"} -> job within 25 s or null;  {action:"result", id, result}
export async function bridge(request) {
  const b = await bridgeAuth(request);
  if (!b) return json({ error: 'Unpaired or revoked. Pair again from Blender.' }, 401);
  const raw = await request.text();
  if (raw.length > 8_000_000) return json({ error: 'Result too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }
  await seen(b);
  if (body.action === 'next') {
    const end = Date.now() + 25_000;
    while (Date.now() < end - 500) {
      const raw = await store.blpop('bmcp:jobs', Math.max(1, Math.round((end - Date.now()) / 1000)));
      if (!raw) break;
      const job = JSON.parse(raw);
      if (Date.now() - job.at < 55_000) return json({ job }); // older jobs: their caller gave up; never run them late
    }
    return json({ job: null });
  }
  if (body.action === 'result' && typeof body.id === 'string' && /^[\w-]{8,64}$/.test(body.id) && body.result) {
    await store.rpush(`bmcp:res:${body.id}`, JSON.stringify(body.result));
    await store.expire(`bmcp:res:${body.id}`, 300);
    return json({ ok: true });
  }
  return json({ error: 'Unknown action' }, 400);
}

export async function bridges() {
  const ids = await store.smembers('bmcp:bridges');
  const out = [];
  for (const id of ids) { const r = await store.get(`bmcp:bridge:${id}`); if (r) out.push(JSON.parse(r)); }
  return out.sort((a, b) => b.created - a.created);
}

export async function unpair(id) {
  await store.del(`bmcp:bridge:${id}`);
  await store.srem('bmcp:bridges', id);
  // Its token now points at nothing (bridgeAuth needs the bridge record).
}

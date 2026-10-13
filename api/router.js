// One function serves every dynamic path (vercel.json rewrites everything that is not a static file
// here, with the original path in ?__p=). One warm function = lower latency than many cold ones.
import { mcp } from '../lib/mcp.js';
import * as oauth from '../lib/oauth.js';
import * as gh from '../lib/github.js';
import * as bl from '../lib/blender.js';
import { store } from '../lib/store.js';
import { session, csrfOk, json, redirect, origin, config, endSession, isSecure, audit } from '../lib/security.js';

function realRequest(request) {
  const u = new URL(request.url);
  const p = u.searchParams.get('__p');
  if (p === null) return request;
  u.searchParams.delete('__p');
  u.pathname = p.startsWith('/') ? p : `/${p}`;
  return new Request(u, request);
}

async function me(request) {
  const s = await session(request);
  const c = config();
  if (!s) return json({ signed_in: false, configured: !c.problems.length, problems: c.problems, login_url: '/auth/github?next=/' });
  return json({ signed_in: true, login: s.login, csrf: s.csrf, connector_url: `${origin(request)}/mcp`, store: store.kind });
}

async function state(request) {
  const s = await session(request);
  if (!s) return json({ error: 'Sign in' }, 401);
  const famIds = await store.smembers('bmcp:fams');
  const clients = [];
  for (const id of famIds) { const r = await store.get(`bmcp:fam:${id}`); if (r) clients.push(JSON.parse(r)); }
  const log = (await store.lrange('bmcp:log', 0, 59)).map((x) => JSON.parse(x));
  return json({
    blender: { online: await bl.online(), last_seen: Number((await store.get('bmcp:seen')) || 0), paired: await bl.bridges() },
    clients: clients.sort((a, b) => b.created - a.created), log, now: Date.now(),
  });
}

async function revoke(request) {
  const s = await session(request);
  if (!csrfOk(s, request)) return json({ error: 'Session expired. Reload.' }, 403);
  const b = await request.json().catch(() => ({}));
  if (b.type === 'client' && b.id) await oauth.revokeFamily(String(b.id));
  else if (b.type === 'blender' && b.id) await bl.unpair(String(b.id));
  else if (b.type === 'all') {
    for (const id of await store.smembers('bmcp:fams')) await oauth.revokeFamily(id);
    for (const id of await store.smembers('bmcp:bridges')) await bl.unpair(id);
    for (const sid of await store.smembers('bmcp:sessions')) { await store.del(`bmcp:sess:${sid}`); await store.srem('bmcp:sessions', sid); }
    await store.del('bmcp:jobs');
    await audit('revoke-all', { login: s.login });
    return json({ ok: true, signed_out: true }, 200, { 'set-cookie': await endSession(s, isSecure(request)) });
  } else return json({ error: 'Unknown' }, 400);
  await audit('revoke', { type: b.type, login: s.login });
  return json({ ok: true });
}

// /pair?code=XXXX-XXXX (opened by the add-on): sign in if needed, then the dashboard with the code filled in.
async function pair(request) {
  const code = String(new URL(request.url).searchParams.get('code') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 9);
  const dest = code ? `/?code=${code}` : '/';
  return (await session(request)) ? redirect(dest) : redirect(`/auth/github?next=${encodeURIComponent(dest)}`);
}

const ROUTES = {
  'GET /pair': pair,
  'GET /.well-known/oauth-protected-resource': oauth.protectedResource,
  'GET /.well-known/oauth-protected-resource/mcp': oauth.protectedResource,
  'GET /.well-known/oauth-authorization-server': oauth.authServer,
  'GET /.well-known/oauth-authorization-server/mcp': oauth.authServer,
  'POST /oauth/register': oauth.register,
  'GET /oauth/authorize': oauth.authorize,
  'POST /oauth/decision': oauth.decision,
  'POST /oauth/token': oauth.tokenEndpoint,
  'POST /oauth/revoke': oauth.revoke,
  'GET /auth/github': gh.start,
  'GET /auth/github/callback': gh.callback,
  'POST /auth/logout': gh.logout,
  'GET /api/me': me,
  'GET /api/state': state,
  'POST /api/revoke': revoke,
  'POST /api/pair/start': bl.pairStart,
  'POST /api/pair/poll': bl.pairPoll,
  'GET /api/pair/lookup': bl.pairLookup,
  'POST /api/pair/approve': bl.pairApprove,
  'POST /api/bridge': bl.bridge,
};

export async function handle(request0) {
  const request = realRequest(request0);
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: oauth.CORS });
  if (path === '/mcp' || path === '/api/mcp') {
    const who = await oauth.bearer(request);
    if (!who) return oauth.challenge(request);
    return mcp(request, who);
  }
  const fn = ROUTES[`${request.method} ${path}`];
  if (!fn) return json({ error: 'Not found' }, 404);
  try { return await fn(request); }
  catch (e) { console.error(path, e); return json({ error: 'Server error' }, 500); }
}

export const GET = handle, POST = handle, OPTIONS = handle, DELETE = handle;

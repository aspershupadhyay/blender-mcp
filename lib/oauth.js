// OAuth 2.1 for MCP clients (the flow Claude, Figma's and GitHub's MCP connectors use):
// discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591), authorization code with
// PKCE S256 only, refresh-token rotation with reuse detection, and revocation. Approval needs the
// owner's signed-in session (GitHub) and an explicit "Allow" on the consent page.
import { store } from './store.js';
import {
  token, sha256, same, seal, unseal, session, csrfOk, json, html, redirect, esc, origin, limited, audit, config,
} from './security.js';

const SCOPE = 'blender';
const ACCESS_TTL = 3600;          // 1 hour
const REFRESH_TTL = 30 * 86400;   // 30 days, rotated on every use
const CODE_TTL = 120;
const CLIENT_TTL = 90 * 86400;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

export function protectedResource(request) {
  const o = origin(request);
  return json({
    resource: `${o}/mcp`, authorization_servers: [o], scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'], resource_name: 'Blender MCP Relay',
    resource_documentation: `${o}/`,
  }, 200, CORS);
}

export function authServer(request) {
  const o = origin(request);
  return json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    service_documentation: `${o}/`,
  }, 200, CORS);
}

const okRedirect = (u) => {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch { return false; }
};

export async function register(request) {
  if (await limited(request, 'register', 20, 3600)) return json({ error: 'slow_down' }, 429, CORS);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'invalid_client_metadata' }, 400, CORS); }
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirect)) {
    return json({ error: 'invalid_redirect_uri', error_description: 'https redirect URIs only (http only for localhost), at most 5' }, 400, CORS);
  }
  const client = {
    client_id: `bmcp_${token(16)}`, client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: String(b.client_name || 'MCP client').slice(0, 80), client_uri: okRedirect(b.client_uri) ? b.client_uri : undefined,
    redirect_uris: uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
  };
  await store.set(`bmcp:client:${client.client_id}`, JSON.stringify(client), CLIENT_TTL);
  return json(client, 201, CORS);
}

const client = async (id) => { const v = await store.get(`bmcp:client:${String(id || '')}`); return v ? JSON.parse(v) : null; };

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Blender MCP Relay</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/app.css"></head>
<body class="sheet"><main class="card narrow">${body}</main><script src="/sheet.js" type="module"></script></body></html>`;
}
export const errorPage = (title, msg, status = 400) =>
  html(page(title, `<img class="mark" src="/icon.svg" alt=""><h1>${esc(title)}</h1><p class="muted">${esc(msg)}</p><a class="btn ghost" href="/">Back to the relay</a>`), status);

// GET /oauth/authorize: check the request, make sure the owner is signed in, then show consent.
export async function authorize(request) {
  const q = new URL(request.url).searchParams;
  const c = await client(q.get('client_id'));
  const redirectUri = q.get('redirect_uri');
  if (!c) return errorPage('Unknown app', 'This app is not registered with the relay. Add the connector again.');
  if (!redirectUri || !c.redirect_uris.includes(redirectUri)) return errorPage('Wrong return address', 'The app asked to return to an address it did not register.');
  const back = (err) => { const u = new URL(redirectUri); u.searchParams.set('error', err); if (q.get('state')) u.searchParams.set('state', q.get('state')); return redirect(u.toString()); };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type');
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') || '')) return back('invalid_request');
  const s = await session(request);
  if (!s) return redirect(`/auth/github?next=${encodeURIComponent(new URL(request.url).pathname + '?' + q.toString())}`);
  const ask = seal({
    sid: s.sid, client_id: c.client_id, redirect_uri: redirectUri, challenge: q.get('code_challenge'),
    state: q.get('state') || '', resource: q.get('resource') || '', scope: SCOPE,
  }, 600);
  const host = new URL(redirectUri).host;
  return html(page('Allow access', `
<img class="mark" src="/icon.svg" alt="">
<p class="eyebrow">Authorization request</p>
<h1><span class="hl">${esc(c.client_name)}</span> wants to control your Blender</h1>
<ul class="perms">
  <li><b>Read</b> your open scene, objects, and materials</li>
  <li><b>Run Python</b> inside Blender (it can change or save files, with your rights on your computer)</li>
  <li><b>See</b> your viewport and renders</li>
</ul>
<p class="muted">Signed in as <b>@${esc(s.login)}</b>. Access returns to <b>${esc(host)}</b>, lasts until you revoke it on the dashboard, and works only while Blender is connected.</p>
<div class="row" data-ask="${esc(ask)}" data-csrf="${esc(s.csrf)}" id="consent">
  <button class="btn ghost" data-decision="deny">Deny</button>
  <button class="btn primary" data-decision="allow">Allow</button>
</div>
<p class="err" id="err" role="alert"></p>`));
}

// POST /oauth/decision (from the consent page, same origin, CSRF header).
export async function decision(request) {
  const s = await session(request);
  if (!csrfOk(s, request)) return json({ error: 'Session expired. Reload the page.' }, 403);
  const b = await request.json().catch(() => ({}));
  const a = unseal(b.ask);
  if (!a || a.sid !== s.sid) return json({ error: 'This request expired. Start again from the app.' }, 400);
  const u = new URL(a.redirect_uri);
  if (a.state) u.searchParams.set('state', a.state);
  u.searchParams.set('iss', origin(request));
  if (!b.allow) {
    u.searchParams.set('error', 'access_denied');
    await audit('deny', { client: a.client_id });
    return json({ redirect: u.toString() });
  }
  const code = token(32);
  await store.set(`bmcp:code:${sha256(code)}`, JSON.stringify({ ...a, login: s.login }), CODE_TTL);
  u.searchParams.set('code', code);
  return json({ redirect: u.toString() });
}

async function issue(grant) {
  const access = `bma_${token(32)}`, refresh = `bmr_${token(32)}`;
  await store.set(`bmcp:at:${sha256(access)}`, JSON.stringify(grant), ACCESS_TTL);
  await store.set(`bmcp:rt:${sha256(refresh)}`, JSON.stringify(grant), REFRESH_TTL);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
}

async function form(request) {
  const t = request.headers.get('content-type') || '';
  if (t.includes('application/json')) return request.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

// POST /oauth/token
export async function tokenEndpoint(request) {
  if (await limited(request, 'token', 60, 60)) return json({ error: 'slow_down' }, 429, CORS);
  const f = await form(request);
  const bad = (error, d) => json({ error, error_description: d }, 400, CORS);
  if (f.grant_type === 'authorization_code') {
    const raw = await store.getdel(`bmcp:code:${sha256(f.code || '')}`);
    if (!raw) return bad('invalid_grant', 'Code is unknown, used, or expired');
    const g = JSON.parse(raw);
    if (g.client_id !== f.client_id || g.redirect_uri !== f.redirect_uri) return bad('invalid_grant', 'Client or redirect does not match');
    if (!f.code_verifier || !same(sha256(f.code_verifier), g.challenge)) return bad('invalid_grant', 'PKCE check failed');
    const c = await client(g.client_id);
    const family = token(12);
    const fam = { id: family, client_id: g.client_id, client_name: c?.client_name || 'MCP client', login: g.login, created: Date.now(), last_used: Date.now() };
    await store.set(`bmcp:fam:${family}`, JSON.stringify(fam), REFRESH_TTL);
    await store.sadd('bmcp:fams', family);
    await audit('grant', { client: fam.client_name, login: g.login });
    return json(await issue({ family, client_id: g.client_id, login: g.login }), 200, CORS);
  }
  if (f.grant_type === 'refresh_token') {
    const h = sha256(f.refresh_token || '');
    const raw = await store.getdel(`bmcp:rt:${h}`);
    if (!raw) {
      // A refresh token used twice means it was copied: end that whole grant.
      const fam = await store.get(`bmcp:rt-used:${h}`);
      if (fam) { await revokeFamily(fam); await audit('reuse', { family: fam }); }
      return bad('invalid_grant', 'Refresh token is unknown, used, or expired');
    }
    const g = JSON.parse(raw);
    if (g.client_id !== f.client_id) return bad('invalid_grant', 'Client does not match');
    if (!(await store.get(`bmcp:fam:${g.family}`))) return bad('invalid_grant', 'Access was revoked');
    await store.set(`bmcp:rt-used:${h}`, g.family, REFRESH_TTL);
    return json(await issue(g), 200, CORS);
  }
  return bad('unsupported_grant_type', 'authorization_code or refresh_token');
}

// POST /oauth/revoke (RFC 7009: always 200)
export async function revoke(request) {
  const f = await form(request);
  const h = sha256(f.token || '');
  for (const k of [`bmcp:at:${h}`, `bmcp:rt:${h}`]) {
    const raw = await store.getdel(k);
    if (raw) await revokeFamily(JSON.parse(raw).family);
  }
  return new Response(null, { status: 200, headers: CORS });
}

export async function revokeFamily(id) {
  await store.del(`bmcp:fam:${id}`);
  await store.srem('bmcp:fams', id);
}

// The MCP door: a valid access token whose grant still exists, for a login still allowed.
export async function bearer(request) {
  const h = request.headers.get('authorization') || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  const raw = await store.get(`bmcp:at:${sha256(h.slice(7).trim())}`);
  if (!raw) return null;
  const g = JSON.parse(raw);
  const famRaw = await store.get(`bmcp:fam:${g.family}`);
  if (!famRaw || !config().allowed.includes(String(g.login).toLowerCase())) return null;
  const fam = JSON.parse(famRaw);
  if (Date.now() - fam.last_used > 60_000) { fam.last_used = Date.now(); await store.set(`bmcp:fam:${g.family}`, JSON.stringify(fam), REFRESH_TTL); }
  return { ...g, client_name: fam.client_name };
}

export function challenge(request) {
  return json({ error: 'invalid_token', error_description: 'Sign in: add this server as a connector and approve it.' }, 401, {
    ...CORS,
    'www-authenticate': `Bearer realm="blender-mcp", error="invalid_token", resource_metadata="${origin(request)}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`,
  });
}

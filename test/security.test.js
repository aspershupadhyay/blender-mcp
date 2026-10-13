// Security and protocol tests, in one process with the in-memory store. No Blender, no code runs.
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.GITHUB_CLIENT_ID = 'x'; process.env.GITHUB_CLIENT_SECRET = 'y';
process.env.ALLOWED_GITHUB_LOGINS = 'owner';
process.env.PUBLIC_URL = 'https://relay.test';
delete process.env.REDIS_URL; delete process.env.KV_URL;
const { handle } = await import('../api/router.js');
const { newSession } = await import('../lib/security.js');

const B = 'https://relay.test';
const call = (path, init = {}) => handle(new Request(B + path, init));
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const cookieOf = (setCookie) => setCookie.split(';')[0];
const s256 = (v) => createHash('sha256').update(v).digest('base64url');

let ownerCookie, csrf;
test('signed out: dashboard data and MCP are closed', async () => {
  assert.equal((await (await call('/api/me')).json()).signed_in, false);
  assert.equal((await call('/api/state')).status, 401);
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/relay\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer bma_fake' })).status, 401);
});

test('discovery documents', async () => {
  const pr = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(pr.resource, `${B}/mcp`);
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${B}/oauth/register`);
});

let client;
test('client registration rejects unsafe redirects', async () => {
  for (const bad of [['http://evil.com/cb'], ['javascript:alert(1)'], [], ['https://a/#frag']]) {
    assert.equal((await post('/oauth/register', { client_name: 'x', redirect_uris: bad })).status, 400, String(bad));
  }
  const r = await post('/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  assert.equal(r.status, 201);
  client = await r.json();
});

test('authorize: unknown client and wrong redirect never redirect away', async () => {
  const q = (o) => '/oauth/authorize?' + new URLSearchParams(o);
  let r = await call(q({ client_id: 'nope', redirect_uri: 'https://evil.com', response_type: 'code' }));
  assert.equal(r.status, 400); assert.equal(r.headers.get('location'), null);
  r = await call(q({ client_id: client.client_id, redirect_uri: 'https://evil.com/cb', response_type: 'code' }));
  assert.equal(r.status, 400); assert.equal(r.headers.get('location'), null);
});

const verifier = randomBytes(40).toString('base64url');
const authQ = () => '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: s256(verifier), code_challenge_method: 'S256', state: 'st8', resource: `${B}/mcp` });

test('authorize: plain PKCE refused; signed-out owner is sent to GitHub sign-in', async () => {
  let r = await call(authQ().replace('S256', 'plain'));
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /error=invalid_request/);
  r = await call(authQ());
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^\/auth\/github\?next=/);
});

test('a session for a login not on the allowlist is ignored', async () => {
  const c = cookieOf(await newSession('intruder', true));
  assert.equal((await (await call('/api/me', { headers: { cookie: c } })).json()).signed_in, false);
});

let code;
test('consent needs the session and its CSRF token; approval returns a code', async () => {
  ownerCookie = cookieOf(await newSession('owner', true));
  const me = await (await call('/api/me', { headers: { cookie: ownerCookie } })).json();
  csrf = me.csrf; assert.equal(me.login, 'owner');
  const page = await (await call(authQ(), { headers: { cookie: ownerCookie } })).text();
  const ask = page.match(/data-ask="([^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(page, /Claude/);
  assert.equal((await post('/oauth/decision', { ask, allow: true }, { cookie: ownerCookie })).status, 403, 'no CSRF');
  assert.equal((await post('/oauth/decision', { ask, allow: true }, { cookie: ownerCookie, 'x-csrf-token': 'wrong' })).status, 403);
  const other = cookieOf(await newSession('owner', true));
  const otherCsrf = (await (await call('/api/me', { headers: { cookie: other } })).json()).csrf;
  assert.equal((await post('/oauth/decision', { ask, allow: true }, { cookie: other, 'x-csrf-token': otherCsrf })).status, 400, 'ask is bound to its session');
  const r = await (await post('/oauth/decision', { ask, allow: true }, { cookie: ownerCookie, 'x-csrf-token': csrf })).json();
  const u = new URL(r.redirect);
  assert.equal(u.origin + u.pathname, client.redirect_uris[0]);
  assert.equal(u.searchParams.get('state'), 'st8');
  assert.equal(u.searchParams.get('iss'), B);
  code = u.searchParams.get('code');
});

const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
let tokens;
test('token: PKCE enforced, code single-use', async () => {
  const base = { grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: client.redirect_uris[0] };
  assert.equal((await call('/oauth/token', form({ ...base, code_verifier: 'wrong'.repeat(10) }))).status, 400);
  // The failed attempt used the code up (getdel), so a fresh approval is needed: that is the safe behaviour.
  assert.equal((await call('/oauth/token', form({ ...base, code_verifier: verifier }))).status, 400);
  const page = await (await call(authQ(), { headers: { cookie: ownerCookie } })).text();
  const ask = page.match(/data-ask="([^"]+)"/)[1].replace(/&amp;/g, '&');
  code = new URL((await (await post('/oauth/decision', { ask, allow: true }, { cookie: ownerCookie, 'x-csrf-token': csrf })).json()).redirect).searchParams.get('code');
  const r = await call('/oauth/token', form({ ...base, code, code_verifier: verifier }));
  assert.equal(r.status, 200);
  tokens = await r.json();
  assert.match(tokens.access_token, /^bma_/); assert.match(tokens.refresh_token, /^bmr_/);
  assert.equal((await call('/oauth/token', form({ ...base, code, code_verifier: verifier }))).status, 400, 'code reuse');
});

const rpc = (method, params, tok) => post('/mcp', { jsonrpc: '2.0', id: 7, method, params }, { authorization: `Bearer ${tok}`, accept: 'application/json, text/event-stream' });
test('MCP with the access token', async () => {
  const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, tokens.access_token)).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await (await rpc('tools/list', {}, tokens.access_token)).json();
  assert.ok(list.result.tools.find((t) => t.name === 'execute_python'));
  const st = await (await rpc('tools/call', { name: 'connection_status', arguments: {} }, tokens.access_token)).json();
  assert.match(st.result.content[0].text, /No Blender is connected/);
  const ex = await (await rpc('tools/call', { name: 'execute_python', arguments: { code: 'print(1)' } }, tokens.access_token)).json();
  assert.equal(ex.result.isError, true, 'refused while no Blender is online (nothing queued)');
  assert.equal((await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${tokens.access_token}` })).status, 202);
});

test('refresh rotates; replaying an old refresh token kills the grant', async () => {
  const r1 = await (await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))).json();
  assert.ok(r1.access_token);
  assert.equal((await rpc('ping', {}, r1.access_token)).status, 200);
  assert.equal((await call('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))).status, 400);
  assert.equal((await rpc('ping', {}, r1.access_token)).status, 401, 'whole grant revoked after reuse');
});

let bridgeToken;
test('pairing a Blender: owner approval required, token handed over once', async () => {
  const st = await (await post('/api/pair/start', { name: 'Test Blender' })).json();
  assert.match(st.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await post('/api/pair/poll', { device_code: st.device_code })).status, 200);
  assert.equal((await (await post('/api/pair/poll', { device_code: st.device_code })).json()).status, 'pending');
  assert.equal((await call(`/api/pair/lookup?code=${st.user_code}`)).status, 401, 'needs sign-in');
  assert.equal((await post('/api/pair/approve', { code: st.user_code, allow: true }, { cookie: ownerCookie })).status, 403, 'needs CSRF');
  const look = await (await call(`/api/pair/lookup?code=${st.user_code}`, { headers: { cookie: ownerCookie } })).json();
  assert.equal(look.name, 'Test Blender');
  assert.equal((await post('/api/pair/approve', { code: st.user_code, allow: true }, { cookie: ownerCookie, 'x-csrf-token': csrf })).status, 200);
  const done = await (await post('/api/pair/poll', { device_code: st.device_code })).json();
  assert.equal(done.status, 'approved'); bridgeToken = done.token;
  assert.equal((await (await post('/api/pair/poll', { device_code: st.device_code })).json()).status, 'expired', 'handed over once');
  assert.equal((await post('/api/bridge', { action: 'result', id: 'x'.repeat(12), result: { ok: true } }, { authorization: 'Bearer bmb_wrong' })).status, 401);
  assert.equal((await post('/api/bridge', { action: 'result', id: 'x'.repeat(12), result: { ok: true } }, { authorization: `Bearer ${bridgeToken}` })).status, 200);
  const state = await (await call('/api/state', { headers: { cookie: ownerCookie } })).json();
  assert.equal(state.blender.paired.length, 1);
  assert.equal(state.blender.online, true);
});

test('kill switch: everything revoked, session ended', async () => {
  assert.equal((await post('/api/revoke', { type: 'all' }, { cookie: ownerCookie })).status, 403, 'needs CSRF');
  const r = await post('/api/revoke', { type: 'all' }, { cookie: ownerCookie, 'x-csrf-token': csrf });
  assert.equal(r.status, 200);
  assert.equal((await post('/api/bridge', { action: 'result', id: 'x'.repeat(12), result: { ok: true } }, { authorization: `Bearer ${bridgeToken}` })).status, 401);
  assert.equal((await (await call('/api/me', { headers: { cookie: ownerCookie } })).json()).signed_in, false);
});

test('security headers on dynamic responses', async () => {
  const r = await call('/api/me');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

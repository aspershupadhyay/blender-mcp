// Tokens, signing, sessions, CSRF, rate limits, and response helpers.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { store } from './store.js';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const token = (bytes = 32) => b64url(randomBytes(bytes));
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('base64url');
export const same = (a, b) => {
  const x = Buffer.from(sha256(a ?? '')), y = Buffer.from(sha256(b ?? ''));
  return timingSafeEqual(x, y);
};

export function config() {
  const c = {
    sessionSecret: process.env.SESSION_SECRET || '',
    githubId: process.env.GITHUB_CLIENT_ID || '',
    githubSecret: process.env.GITHUB_CLIENT_SECRET || '',
    allowed: (process.env.ALLOWED_GITHUB_LOGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
  c.problems = [];
  if (c.sessionSecret.length < 32) c.problems.push('SESSION_SECRET (32+ random characters)');
  if (!c.githubId || !c.githubSecret) c.problems.push('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (a GitHub OAuth app)');
  if (!c.allowed.length) c.problems.push('ALLOWED_GITHUB_LOGINS (your GitHub username)');
  return c;
}

// ------------------------------------------------------------- signed values (HMAC-SHA256)
const sign = (data) => createHmac('sha256', config().sessionSecret).update(data).digest('base64url');
export function seal(obj, ttlSec) {
  const body = b64url(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${sign(body)}`;
}
export function unseal(s) {
  if (!s || typeof s !== 'string' || !s.includes('.')) return null;
  const [body, mac] = s.split('.');
  if (!same(mac, sign(body))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() / 1000 ? o : null;
  } catch { return null; }
}

// ------------------------------------------------------------- cookies and sessions
export function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export const cookie = (name, value, maxAge, secure = true) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

const SESSION = '__Host-bmcp';  // __Host-: Secure, Path=/, no Domain: cannot be set by a subdomain
const SESSION_DEV = 'bmcp';
export const sessionName = (secure) => (secure ? SESSION : SESSION_DEV);

// A session is a signed cookie plus a server record, so signing out (or "revoke everything") ends it.
export async function session(request) {
  const c = cookies(request);
  const s = unseal(c[SESSION] || c[SESSION_DEV]);
  if (!s || !(await store.get(`bmcp:sess:${s.sid}`))) return null;
  if (!config().allowed.includes(String(s.login).toLowerCase())) return null;
  return s;
}
export async function newSession(login, secure) {
  const sid = token(18);
  await store.set(`bmcp:sess:${sid}`, login, 12 * 3600);
  await store.sadd('bmcp:sessions', sid);
  return cookie(sessionName(secure), seal({ sid, login, csrf: token(18) }, 12 * 3600), 12 * 3600, secure);
}
export async function endSession(s, secure) {
  if (s) { await store.del(`bmcp:sess:${s.sid}`); await store.srem('bmcp:sessions', s.sid); }
  return cookie(sessionName(secure), '', 0, secure);
}
export const csrfOk = (s, request) => !!s && same(request.headers.get('x-csrf-token'), s.csrf);

// ------------------------------------------------------------- rate limits
export async function limited(request, bucket, max, windowSec) {
  const ip = (request.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const n = await store.incr(`bmcp:rl:${bucket}:${ip}:${Math.floor(Date.now() / 1000 / windowSec)}`, windowSec);
  return n > max;
}

// ------------------------------------------------------------- responses
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json', ...extra } });
export const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra } });
export const redirect = (to, extra = {}) => new Response(null, { status: 302, headers: { ...HEADERS, location: to, ...extra } });
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function origin(request) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || u.host;
  const proto = request.headers.get('x-forwarded-proto') || u.protocol.replace(':', '');
  return `${proto}://${host}`;
}
export const isSecure = (request) => origin(request).startsWith('https://');

// ------------------------------------------------------------- activity log (shown on the dashboard)
export async function audit(kind, detail) {
  await store.lpushCap('bmcp:log', JSON.stringify({ t: Date.now(), kind, ...detail }), 100);
}

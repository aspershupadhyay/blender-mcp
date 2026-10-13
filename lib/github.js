// Owner sign-in with GitHub. Only logins in ALLOWED_GITHUB_LOGINS get a session.
import { token, seal, unseal, cookies, cookie, newSession, endSession, session, redirect, origin, isSecure, limited, audit, config, csrfOk, json } from './security.js';
import { errorPage } from './oauth.js';

const FLOW = 'bmcp_gh';
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

export async function start(request) {
  const c = config();
  if (c.problems.length) return errorPage('Not set up yet', `Set these in Vercel, then redeploy: ${c.problems.join('; ')}.`, 500);
  if (await limited(request, 'login', 30, 600)) return errorPage('Too many attempts', 'Wait a few minutes and try again.', 429);
  const state = token(24);
  const next = safeNext(new URL(request.url).searchParams.get('next'));
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', c.githubId);
  u.searchParams.set('redirect_uri', `${origin(request)}/auth/github/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return redirect(u.toString(), { 'set-cookie': cookie(FLOW, seal({ state, next }, 600), 600, isSecure(request)) });
}

export async function callback(request) {
  const c = config();
  const q = new URL(request.url).searchParams;
  const flow = unseal(cookies(request)[FLOW]);
  if (!flow || !q.get('state') || q.get('state') !== flow.state) return errorPage('Sign-in expired', 'Start the sign-in again.');
  const tr = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: c.githubId, client_secret: c.githubSecret, code: q.get('code'), redirect_uri: `${origin(request)}/auth/github/callback` }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!tr.access_token) return errorPage('GitHub sign-in failed', 'GitHub did not confirm the sign-in. Try again.');
  const user = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tr.access_token}`, 'user-agent': 'blender-mcp-relay', accept: 'application/vnd.github+json' } })
    .then((r) => r.json()).catch(() => ({}));
  // The GitHub token is not kept: it was only needed to learn who signed in.
  const login = String(user.login || '');
  if (!login || !c.allowed.includes(login.toLowerCase())) {
    await audit('login-refused', { login });
    return errorPage('Not allowed', `@${login || 'unknown'} is not an owner of this relay.`, 403);
  }
  await audit('login', { login });
  const secure = isSecure(request);
  const headers = new Headers({ location: safeNext(flow.next) });
  headers.append('set-cookie', await newSession(login, secure));
  headers.append('set-cookie', cookie(FLOW, '', 0, secure));
  return new Response(null, { status: 302, headers });
}

export async function logout(request) {
  const s = await session(request);
  if (!csrfOk(s, request)) return json({ error: 'Session expired' }, 403);
  return json({ ok: true }, 200, { 'set-cookie': await endSession(s, isSecure(request)) });
}

// Dashboard: who is signed in, Blender status, pairing, connected apps, activity, kill switch.
const $ = (id) => document.getElementById(id);
let me = null;
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2400); };
const ago = (ms) => { if (!ms) return 'never'; const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me?.csrf || '' }, body: JSON.stringify(body), credentials: 'same-origin' } : { credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status, body: j });
  return j;
}

async function boot() {
  try { me = await api('/api/me'); } catch { me = { signed_in: false }; }
  if (!me.signed_in) {
    $('landing').classList.remove('hidden');
    if (me.configured === false) $('setup').textContent = `Owner: finish setup in Vercel first: ${me.problems.join('; ')}.`;
    me = null;
    return;
  }
  $('dash').classList.remove('hidden');
  $('who').classList.remove('hidden');
  $('login').textContent = `@${me.login}`;
  $('hello').textContent = `@${me.login}`;
  $('avatar').src = `https://avatars.githubusercontent.com/${encodeURIComponent(me.login)}?s=64`;
  $('url').textContent = me.connector_url;
  const code = new URLSearchParams(location.search).get('code');
  if (code) { $('code').value = code; lookup(); }
  refresh(); setInterval(refresh, 4000);
}

let lastLog = 0;
async function refresh() {
  let s;
  try { s = await api('/api/state'); } catch (e) { if (e.status === 401) location.reload(); return; }
  const on = s.blender.online;
  $('orb').classList.toggle('on', on);
  $('bl-state').textContent = on ? 'Connected' : s.blender.paired.length ? 'Offline' : 'Not paired yet';
  $('bl-seen').textContent = on ? 'Ready for jobs' : `Last seen ${ago(s.blender.last_seen)}`;

  const bl = $('blenders'); bl.replaceChildren();
  if (!s.blender.paired.length) bl.append(el('div', 'empty', 'No Blender paired. Press Pair in the add-on.'));
  for (const b of s.blender.paired) {
    const li = el('li'), d = el('span', 'dot' + (Date.now() - b.last_seen < 40000 ? ' on' : '')), g = el('div', 'grow');
    g.append(el('b', '', b.name), el('span', 'faint', `Paired ${ago(b.created)} · seen ${ago(b.last_seen)}`));
    const x = el('button', 'btn sm danger', 'Unpair'); x.type = 'button';
    x.onclick = async () => { if (!confirm(`Unpair ${b.name}? Its key stops working at once.`)) return; await api('/api/revoke', { type: 'blender', id: b.id }); toast('Unpaired'); refresh(); };
    li.append(d, g, x); bl.append(li);
  }

  const cl = $('clients'); cl.replaceChildren();
  if (!s.clients.length) cl.append(el('div', 'empty', 'No apps yet. Add the connector URL in Claude.'));
  for (const c of s.clients) {
    const li = el('li'), g = el('div', 'grow');
    g.append(el('b', '', c.client_name), el('span', 'faint', `Approved ${ago(c.created)} · used ${ago(c.last_used)}`));
    const x = el('button', 'btn sm danger', 'Revoke'); x.type = 'button';
    x.onclick = async () => { if (!confirm(`Revoke ${c.client_name}?`)) return; await api('/api/revoke', { type: 'client', id: c.id }); toast('Revoked'); refresh(); };
    li.append(el('span', 'dot on'), g, x); cl.append(li);
  }

  const lg = $('log'); lg.replaceChildren();
  if (!s.log.length) lg.append(el('div', 'empty', 'Nothing yet.'));
  for (const e of s.log) {
    const row = el('div');
    const what = e.kind === 'tool' ? e.tool : e.kind;
    const detail = e.kind === 'tool' ? (e.client || '') : (e.login ? `@${e.login}` : e.name || e.client || '');
    const res = e.kind === 'tool' ? el('span', e.ok === false ? 'no' : 'ok', e.ok === null ? 'running' : `${e.ms} ms`) : el('span', '', '');
    row.append(el('span', '', time(e.t)), el('span', 'k', what), el('span', '', detail), res);
    lg.append(row);
  }
  if (s.log[0] && s.log[0].t > lastLog && s.log[0].kind === 'tool') dispatchEvent(new Event('relay:pulse'));
  lastLog = s.log[0]?.t || lastLog;
}

// Pairing
let pending = null;
async function lookup() {
  $('pairerr').textContent = ''; $('pairask').classList.add('hidden');
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) { $('pairerr').textContent = 'Codes look like ABCD-2345.'; return; }
  try {
    const r = await api(`/api/pair/lookup?code=${encodeURIComponent(code.includes('-') ? code : code.slice(0, 4) + '-' + code.slice(4))}`);
    pending = r.code; $('pairname').textContent = r.name; $('pairask').classList.remove('hidden');
  } catch (e) { $('pairerr').textContent = e.message; }
}
$('pairform').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
$('code').addEventListener('input', (e) => { let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8); e.target.value = v; });
async function decide(allow) {
  try { const r = await api('/api/pair/approve', { code: pending, allow }); toast(allow ? `Paired ${r.name || ''}. Blender connects by itself.` : 'Denied'); }
  catch (e) { $('pairerr').textContent = e.message; }
  $('pairask').classList.add('hidden'); $('code').value = ''; history.replaceState(null, '', '/'); refresh();
}
$('pairallow').onclick = () => decide(true);
$('pairdeny').onclick = () => decide(false);

$('copy').onclick = async () => { await navigator.clipboard.writeText(me.connector_url); toast('Copied'); };
$('logout').onclick = async () => { await api('/auth/logout', {}).catch(() => {}); location.href = '/'; };
$('killall').onclick = async () => {
  if (!confirm('Revoke every app, unpair every Blender, and sign out everywhere?')) return;
  await api('/api/revoke', { type: 'all' }); location.href = '/';
};
boot();

// Local stand-in for Vercel: static files from public/, everything else through api/router.js.
// Without REDIS_URL it uses the in-memory store (one process).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { handle } from '../api/router.js';

const PUB = new URL('../public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function start(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = normalize(file).replace(/^(\.\.[/\\])+/, '');
    if (req.method === 'GET') {
      try { const b = await readFile(join(PUB, file)); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(b); return; } catch {}
    }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const out = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
    const headers = {}; out.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? out.headers.getSetCookie() : v; });
    res.writeHead(out.status, headers); res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) start().then(() => console.log(`relay on http://localhost:${process.env.PORT || 3000}`));

// Local stand-in for Vercel: serves api/*.js on http://localhost:PORT with Web Request/Response.
// Without Redis variables it uses the in-memory queue (fine in this one process).
import http from 'node:http';
import * as mcp from '../api/mcp.js';
import * as bridge from '../api/bridge.js';

const routes = { '/api/mcp': mcp, '/api/bridge': bridge };

export function start(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const mod = routes[url.pathname];
    const fn = mod && mod[req.method];
    if (!fn) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = await fn(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`relay on http://localhost:${process.env.PORT || 3000}`));
}

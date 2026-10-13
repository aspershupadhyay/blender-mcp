// MCP over Streamable HTTP, stateless, one JSON reply per request (no server-sent events).
import { TOOLS, callTool } from './tools.js';
import { json } from './security.js';
import { CORS } from './oauth.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'blender-mcp-relay', title: 'Blender MCP Relay', version: '2.0.0', icons: [{ src: '/icon.svg', mimeType: 'image/svg+xml' }] };
const INSTRUCTIONS = 'Controls the user\'s running Blender through their own relay. Start with get_scene_info. '
  + 'Change things with execute_python (bpy; variables persist). Check results with viewport_screenshot or render_image. '
  + 'Keep each call short; never save over the user\'s file unless asked.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, who) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid request');
  const note = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: INFO, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: TOOLS });
    case 'tools/call':
      try { return ok(msg.id, await callTool(msg.params?.name, msg.params?.arguments || {}, who)); }
      catch (e) { return ok(msg.id, { content: [{ type: 'text', text: `Relay error: ${e.message}` }], isError: true }); }
    default:
      return note ? null : fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function mcp(request, who) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST', ...CORS } });
  let body;
  try { body = await request.json(); } catch { return json(fail(null, -32700, 'Parse error'), 400, CORS); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, who)))).filter(Boolean);
    return out.length ? json(out, 200, CORS) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await handle(body, who);
  return out ? json(out, 200, CORS) : new Response(null, { status: 202, headers: CORS });
}

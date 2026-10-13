// MCP endpoint (Streamable HTTP, stateless, JSON responses): POST /api/mcp?key=<RELAY_TOKEN>
// Answers initialize, ping, tools/list, and tools/call. No server-sent events: every request gets
// one JSON reply, which the spec allows.
import { authorized, json } from '../lib/auth.js';
import { TOOLS, callTool } from '../lib/tools.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'blender-mcp-relay', version: '1.0.0' };
const INSTRUCTIONS = 'Drives a running Blender on the user\'s computer through a relay. Start with get_scene_info. '
  + 'Make changes with execute_python (bpy). Check your work with viewport_screenshot or render_image. '
  + 'Do not save over the user\'s file unless they ask.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid request');
  const isNote = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      try { return ok(msg.id, await callTool(msg.params?.name, msg.params?.arguments || {})); }
      catch (e) { return ok(msg.id, { content: [{ type: 'text', text: `Relay error: ${e.message}` }], isError: true }); }
    }
    default:
      if (isNote) return null; // notifications/initialized, notifications/cancelled, ...
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(request) {
  const a = authorized(request, { allowQuery: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  let body;
  try { body = await request.json(); } catch { return json(fail(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(body);
  return out ? json(out) : new Response(null, { status: 202 });
}

// No server-to-client stream and no sessions.
export function GET() { return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } }); }
export function DELETE() { return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } }); }

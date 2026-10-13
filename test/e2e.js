// End to end: dev relay + headless Blender (bpy) + the official MCP client.
//   RELAY_TOKEN=... node test/e2e.js   (needs: pip install bpy)
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.RELAY_TOKEN ||= 'test-token-0123456789abcdef0123456789abcdef';
const { start } = await import('./dev-server.js');
const PORT = 3917, BASE = `http://localhost:${PORT}`;
const server = await start(PORT);
const T = process.env.RELAY_TOKEN;

// 1. Auth: no key, wrong key.
assert.equal((await fetch(`${BASE}/api/mcp`, { method: 'POST', body: '{}' })).status, 401);
assert.equal((await fetch(`${BASE}/api/mcp?key=wrong`, { method: 'POST', body: '{}' })).status, 401);
assert.equal((await fetch(`${BASE}/api/bridge?key=${T}`, { method: 'POST', body: '{"action":"next"}' })).status, 401, 'bridge takes the header only');
console.log('ok  auth');

const client = new Client({ name: 'e2e', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp?key=${T}`)));
const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('execute_python'));
console.log('ok  tools/list', tools.join(', '));

// 2. Blender offline.
let r = await client.callTool({ name: 'get_scene_info', arguments: {} });
assert.equal(r.isError, true);
console.log('ok  offline ->', r.content[0].text);

// 3. Blender online (headless bpy).
const py = spawn('python3', ['test/blender_headless.py', BASE, T, '90'], { stdio: ['ignore', 'pipe', 'pipe'] });
py.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
for (let i = 0; i < 60; i++) {
  r = await client.callTool({ name: 'connection_status', arguments: {} });
  if (r.content[0].text.startsWith('Blender is connected')) break;
  await new Promise((s) => setTimeout(s, 500));
}
assert.match(r.content[0].text, /^Blender is connected/);
console.log('ok  connection_status');

r = await client.callTool({ name: 'get_scene_info', arguments: {} });
assert.match(r.content[0].text, /"Cube"/);
console.log('ok  get_scene_info');

r = await client.callTool({ name: 'execute_python', arguments: { code: "bpy.data.objects['Cube'].location.z = 1.5\nprint('moved')\nresult = round(bpy.data.objects['Cube'].location.z, 2)" } });
assert.match(r.content[0].text, /moved[\s\S]*result = 1\.5/);
console.log('ok  execute_python');

r = await client.callTool({ name: 'execute_python', arguments: { code: 'raise ValueError("boom")' } });
assert.equal(r.isError, true); assert.match(r.content[0].text, /ValueError: boom/);
console.log('ok  execute_python error');

r = await client.callTool({ name: 'get_object_info', arguments: { name: 'Cube' } });
assert.match(r.content[0].text, /"vertices": 8/);
console.log('ok  get_object_info');

r = await client.callTool({ name: 'render_image', arguments: { engine: 'BLENDER_WORKBENCH', width: 320, height: 240, max_size: 320 } });
const img = r.content.find((c) => c.type === 'image');
assert.ok(img && img.data.length > 1000, 'got an image');
console.log('ok  render_image', Math.round(img.data.length * 0.75 / 1024), 'KB png');

r = await client.callTool({ name: 'viewport_screenshot', arguments: {} });
assert.equal(r.isError, true);
console.log('ok  viewport_screenshot refuses in background mode');

await client.close();
py.kill(); server.close();
console.log('all passed');
process.exit(0);

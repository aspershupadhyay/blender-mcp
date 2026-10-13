// The tools Claude sees. Each call becomes a job in the queue; the Blender add-on takes it, runs it
// inside Blender, and posts the result back. A job that outlives one request (a long render) can be
// collected later with get_result.
import { randomUUID } from 'node:crypto';
import { store } from './store.js';

const WAIT_MS = 50_000;   // under Vercel's 60 s function limit (vercel.json)
const POLL_MS = 400;
const ONLINE_MS = 45_000; // the add-on asks for work at least this often while connected

export const TOOLS = [
  {
    name: 'get_scene_info',
    description: 'List the open Blender scene: objects (name, type, location, dimensions, materials, modifiers, parent), the active camera, render engine, and frame.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_object_info',
    description: 'Details of one object: transform, mesh counts, materials and their node trees, modifiers, bones (armatures), shape keys.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Object name' } }, required: ['name'], additionalProperties: false },
  },
  {
    name: 'execute_python',
    description: 'Run Python inside Blender (bpy is imported). Returns what it prints, and the value of a variable named `result` if the code sets one. Use it for any change: modelling, materials, sculpt data, posing, imports, exports, saving. Runs on Blender\'s main thread; keep each call short (under about 45 s).',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Python source' } }, required: ['code'], additionalProperties: false },
  },
  {
    name: 'viewport_screenshot',
    description: 'A picture of the largest 3D viewport, as the user sees it. Needs Blender with a window (not background mode).',
    inputSchema: { type: 'object', properties: { max_size: { type: 'integer', minimum: 128, maximum: 1600, default: 900 } }, additionalProperties: false },
  },
  {
    name: 'render_image',
    description: 'Render the active camera and return the image. Optional: engine (CYCLES, BLENDER_EEVEE_NEXT, BLENDER_WORKBENCH), samples, resolution. Long renders return a job id; collect with get_result.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: { type: 'string' }, samples: { type: 'integer', minimum: 1, maximum: 4096 },
        width: { type: 'integer', minimum: 64, maximum: 4096 }, height: { type: 'integer', minimum: 64, maximum: 4096 },
        max_size: { type: 'integer', minimum: 128, maximum: 2048, default: 1024, description: 'Longest side of the returned image' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_result',
    description: 'Collect the result of an earlier call that was still running (it returned a job id).',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  },
  {
    name: 'connection_status',
    description: 'Whether Blender is connected to the relay now, and when it last asked for work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The add-on's result: { ok, text?, image?: { data (base64), mime }, error? }.
function toContent(r) {
  if (!r.ok) return text(r.error || 'Blender reported an error.', true);
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mime || 'image/png' });
  if (!content.length) content.push({ type: 'text', text: 'Done.' });
  return { content };
}

async function waitFor(id) {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    const r = await store.takeResult(id);
    if (r) return toContent(r);
    await sleep(POLL_MS);
  }
  return text(`Still running in Blender. Job id: ${id}. Call get_result with this id to collect it.`);
}

export async function callTool(name, args = {}) {
  if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);
  const seen = await store.lastSeen();
  const online = Date.now() - seen < ONLINE_MS;
  if (name === 'connection_status') {
    return text(online ? `Blender is connected (last asked for work ${Math.round((Date.now() - seen) / 1000)} s ago).`
      : seen ? `Blender is not connected (last seen ${new Date(seen).toISOString()}). Open Blender, N panel > MCP Relay > Connect.`
        : 'Blender has never connected. Install the add-on, set the relay URL and token, and press Connect.');
  }
  if (name === 'get_result') return waitFor(String(args.job_id || ''));
  if (!online) return text('Blender is not connected. In Blender: N panel > MCP Relay > Connect.', true);
  const id = randomUUID();
  await store.pushJob({ id, tool: name, args, at: Date.now() });
  return waitFor(id);
}

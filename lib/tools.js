// The tools an MCP client sees. A call becomes a job; the paired Blender takes it (BLPOP, so at once),
// runs it on Blender's main thread, and pushes the result, which this side also takes with BLPOP.
// Round trip = network time + Blender's work; there is no polling delay.
import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import { online } from './blender.js';
import { audit } from './security.js';

const WAIT_S = 52; // under the 60 s function limit (vercel.json)

export const TOOLS = [
  {
    name: 'get_scene_info',
    title: 'Scene overview',
    description: 'List the open Blender scene: every object (name, type, location, dimensions, materials, modifiers, parent and parent bone), the active camera, render engine, resolution, frame, and file path. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_object_info',
    title: 'Object details',
    description: 'Details of one object: transform, mesh counts, UV maps, attributes, shape keys, modifiers, materials with their shader nodes and images, and bones for armatures.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact object name from get_scene_info' } }, required: ['name'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'execute_python',
    title: 'Run Python in Blender',
    description: 'Run Python inside Blender with bpy imported; variables persist between calls. Returns printed output and the value of `result` if set. Use for any change: modelling, sculpt data, materials and nodes, rigging and posing, lights, cameras, imports and exports, saving. Runs on the main thread: keep each call under about 45 s and split long work. Do not save over the user\'s file unless they ask.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Python source' } }, required: ['code'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'viewport_screenshot',
    title: 'Viewport screenshot',
    description: 'A picture of the largest 3D viewport as the user sees it. Use it to check your work.',
    inputSchema: { type: 'object', properties: { max_size: { type: 'integer', minimum: 128, maximum: 1600, default: 1000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'render_image',
    title: 'Render',
    description: 'Render the active camera and return the image. Optional engine (CYCLES, BLENDER_EEVEE_NEXT, BLENDER_WORKBENCH), samples, width, height, max_size of the returned image. The scene settings are restored afterwards. A render longer than about 50 s returns a job id: collect it with get_result.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: { type: 'string' }, samples: { type: 'integer', minimum: 1, maximum: 4096 },
        width: { type: 'integer', minimum: 64, maximum: 4096 }, height: { type: 'integer', minimum: 64, maximum: 4096 },
        max_size: { type: 'integer', minimum: 128, maximum: 2048, default: 1200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_result',
    title: 'Collect a long job',
    description: 'Collect the result of an earlier call that returned a job id because it was still running.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'connection_status',
    title: 'Connection status',
    description: 'Whether a paired Blender is connected right now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function toContent(r) {
  if (!r.ok) return text(r.error || 'Blender reported an error.', true);
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mime || 'image/png' });
  if (!content.length) content.push({ type: 'text', text: 'Done.' });
  return { content };
}

async function wait(id) {
  const raw = await store.blpop(`bmcp:res:${id}`, WAIT_S);
  if (!raw) return { result: text(`Still running in Blender. Job id: ${id}. Call get_result with it.`), done: false };
  return { result: toContent(JSON.parse(raw)), done: true, ok: JSON.parse(raw).ok };
}

export async function callTool(name, args = {}, who = {}) {
  if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);
  if (name === 'connection_status') {
    return text((await online()) ? 'Blender is connected.' : 'No Blender is connected. In Blender: N panel > MCP Relay > Connect (pair it first on the relay page).');
  }
  if (name === 'get_result') {
    if (!/^[\w-]{8,64}$/.test(String(args.job_id || ''))) return text('Bad job id.', true);
    return (await wait(String(args.job_id))).result;
  }
  if (!(await online())) return text('No Blender is connected. In Blender: N panel > MCP Relay > Connect.', true);
  const id = randomUUID();
  const t0 = Date.now();
  await store.rpush('bmcp:jobs', JSON.stringify({ id, tool: name, args, at: t0 }));
  await store.expire('bmcp:jobs', 120); // jobs nobody takes in 2 minutes are dropped
  const w = await wait(id);
  await audit('tool', { tool: name, ms: Date.now() - t0, ok: w.done ? w.ok : null, client: who.client_name || '' });
  return w.result;
}

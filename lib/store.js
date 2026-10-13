// The job queue between the MCP endpoint and Blender.
// Production: Upstash Redis (Vercel Marketplace sets KV_REST_API_* or UPSTASH_REDIS_REST_*).
// Local development (no Redis variables): an in-memory queue, valid only in one process.
import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const JOBS = 'bmcp:jobs';
const SEEN = 'bmcp:seen';
const RES = (id) => `bmcp:res:${id}`;
const TTL = 300; // seconds a result or a waiting job lives

function memory() {
  const jobs = [];
  const kv = new Map();
  const get = (k) => { const e = kv.get(k); if (!e) return null; if (e.until < Date.now()) { kv.delete(k); return null; } return e.v; };
  return {
    kind: 'memory',
    async pushJob(job) { jobs.push(JSON.stringify(job)); },
    async popJob() { return jobs.length ? JSON.parse(jobs.shift()) : null; },
    async setResult(id, r) { kv.set(RES(id), { v: JSON.stringify(r), until: Date.now() + TTL * 1000 }); },
    async takeResult(id) { const v = get(RES(id)); if (v) kv.delete(RES(id)); return v ? JSON.parse(v) : null; },
    async markSeen() { kv.set(SEEN, { v: String(Date.now()), until: Date.now() + TTL * 1000 }); },
    async lastSeen() { return Number(get(SEEN) || 0); },
  };
}

function redis() {
  const r = new Redis({ url, token, automaticDeserialization: false });
  return {
    kind: 'redis',
    async pushJob(job) { await r.rpush(JOBS, JSON.stringify(job)); await r.expire(JOBS, TTL); },
    async popJob() { const v = await r.lpop(JOBS); return v ? JSON.parse(v) : null; },
    async setResult(id, res) { await r.set(RES(id), JSON.stringify(res), { ex: TTL }); },
    async takeResult(id) { const v = await r.getdel(RES(id)); return v ? JSON.parse(v) : null; },
    async markSeen() { await r.set(SEEN, String(Date.now()), { ex: TTL }); },
    async lastSeen() { return Number((await r.get(SEEN)) || 0); },
  };
}

export const store = url && token ? redis() : memory();

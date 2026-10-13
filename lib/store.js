// Storage for queues, tokens, sessions and the activity log.
// Production: Redis over TCP (REDIS_URL or KV_URL, which Vercel's Upstash integration sets), so the
// relay can use BLPOP: a job or a result is handed over the moment it exists, with no polling loop.
// Local development (no REDIS_URL): an in-memory store with the same behaviour, one process only.
import Redis from 'ioredis';

const URL_ = process.env.REDIS_URL || process.env.KV_URL;

function memory() {
  const kv = new Map();      // key -> { v, until }
  const lists = new Map();   // key -> array
  const waiters = new Map(); // key -> [resolve]
  const alive = (k) => { const e = kv.get(k); if (!e) return null; if (e.until && e.until < Date.now()) { kv.delete(k); return null; } return e; };
  const list = (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
  const wake = (k) => { const w = waiters.get(k); if (w && w.length && list(k).length) w.shift()(list(k).shift()); };
  return {
    kind: 'memory',
    async get(k) { return alive(k)?.v ?? null; },
    async set(k, v, ttl) { kv.set(k, { v: String(v), until: ttl ? Date.now() + ttl * 1000 : 0 }); },
    async del(k) { kv.delete(k); lists.delete(k); },
    async getdel(k) { const v = alive(k)?.v ?? null; kv.delete(k); return v; },
    async incr(k, ttl) { const e = alive(k); const n = (e ? Number(e.v) : 0) + 1; kv.set(k, { v: String(n), until: e?.until || (ttl ? Date.now() + ttl * 1000 : 0) }); return n; },
    async rpush(k, v) { list(k).push(String(v)); wake(k); },
    async lpushCap(k, v, cap) { const l = list(k); l.unshift(String(v)); l.length = Math.min(l.length, cap); },
    async lrange(k, a, b) { const l = list(k); return l.slice(a, b < 0 ? l.length + b + 1 : b + 1); },
    async blpop(k, sec) {
      const l = list(k);
      if (l.length) return l.shift();
      return new Promise((resolve) => {
        const arr = waiters.get(k) || []; waiters.set(k, arr);
        const done = (v) => { clearTimeout(t); resolve(v); };
        const t = setTimeout(() => { const i = arr.indexOf(done); if (i >= 0) arr.splice(i, 1); resolve(null); }, sec * 1000);
        arr.push(done);
      });
    },
    async sadd(k, v) { const s = new Set(JSON.parse((await this.get(k)) || '[]')); s.add(v); await this.set(k, JSON.stringify([...s])); },
    async srem(k, v) { const s = new Set(JSON.parse((await this.get(k)) || '[]')); s.delete(v); await this.set(k, JSON.stringify([...s])); },
    async smembers(k) { return JSON.parse((await this.get(k)) || '[]'); },
    async expire() {},
  };
}

function redis() {
  const opts = { maxRetriesPerRequest: 2, enableReadyCheck: false, lazyConnect: false, connectTimeout: 5000 };
  const main = new Redis(URL_, opts);
  return {
    kind: 'redis',
    get: (k) => main.get(k),
    set: (k, v, ttl) => (ttl ? main.set(k, String(v), 'EX', ttl) : main.set(k, String(v))),
    del: (k) => main.del(k),
    getdel: (k) => main.getdel(k),
    async incr(k, ttl) { const n = await main.incr(k); if (n === 1 && ttl) await main.expire(k, ttl); return n; },
    rpush: (k, v) => main.rpush(k, String(v)),
    async lpushCap(k, v, cap) { await main.multi().lpush(k, String(v)).ltrim(k, 0, cap - 1).exec(); },
    lrange: (k, a, b) => main.lrange(k, a, b),
    // A blocking pop holds its connection, so each one gets its own (reused for later pops).
    async blpop(k, sec) {
      const c = pool.pop() || new Redis(URL_, opts);
      try { const r = await c.blpop(k, sec); return r ? r[1] : null; }
      finally { if (pool.length < 4) pool.push(c); else c.disconnect(); }
    },
    sadd: (k, v) => main.sadd(k, v),
    srem: (k, v) => main.srem(k, v),
    smembers: (k) => main.smembers(k),
    expire: (k, s) => main.expire(k, s),
  };
}
const pool = [];

export const store = URL_ ? redis() : memory();
export const isProduction = () => store.kind === 'redis';

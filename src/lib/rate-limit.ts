// Limiteur à fenêtre glissante, en mémoire du processus.
// Suffisant pour une instance unique (cas Docker/Dokploy par défaut). Pour plusieurs réplicas,
// remplacer par un stockage partagé (Redis, PostgreSQL).
type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (now - lastSweep > 60_000) sweep(now, windowMs);
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000));
    buckets.set(key, bucket);
    return { ok: false, retryAfterSec };
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { ok: true };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

function sweep(now: number, windowMs: number) {
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.hits.every((t) => now - t >= Math.max(windowMs, 15 * 60_000))) buckets.delete(key);
  }
}

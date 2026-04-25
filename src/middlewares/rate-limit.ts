import type { RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };

/**
 * Rate limit in-memory (dev/early). Replace with Redis/Cloud Armor later.
 */
export function simpleRateLimit(options: { windowMs: number; max: number }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max } = options;

  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}`;
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > max) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}


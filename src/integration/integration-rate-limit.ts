import type { RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 60;

export const integrationRateLimit: RequestHandler = (req, res, next) => {
  const credentialId = String((req as any).credentialId ?? "").trim();
  const ip = String(req.ip ?? "");
  const key = credentialId ? `integration:${credentialId}` : `integration-ip:${ip}`;
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  existing.count += 1;
  if (existing.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    res.setHeader("retry-after", String(retryAfter));
    res.status(429).json({
      type: "https://api.example.com/problems/rate-limit",
      title: "Too Many Requests",
      status: 429,
      detail: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      instance: req.originalUrl,
    });
    return;
  }
  next();
};

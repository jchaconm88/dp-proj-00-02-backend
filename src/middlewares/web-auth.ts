import type { RequestHandler } from "express";
import { getWebAuth } from "../lib/firebase-admin.js";

/**
 * Middleware de autenticación para rutas /web/* y /mobile/*.
 * Valida el Firebase ID Token contra el proyecto Web.
 */
export const requireWebAuth: RequestHandler = async (req, res, next) => {
  if (process.env.WEB_AUTH_DISABLED === "true") return next();
  try {
    const header = String(req.header("authorization") ?? "").trim();
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "unauthenticated", reason: "missing_bearer_token" });
    const decoded = await getWebAuth().verifyIdToken(token);
    (req as unknown as { auth?: unknown }).auth = decoded;
    next();
  } catch (e) {
    const debug = process.env.AUTH_DEBUG === "1";
    const msg = e instanceof Error ? e.message : "verify_failed";
    // eslint-disable-next-line no-console
    console.error("[web-auth] verifyIdToken failed:", msg);
    res.status(401).json({
      error: "unauthenticated",
      reason: "invalid_id_token",
      ...(debug ? { message: msg } : {}),
    });
  }
};

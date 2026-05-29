import type { RequestHandler } from "express";
import { verifyToken } from "./integration-auth.service.js";

export const integrationAuthMiddleware: RequestHandler = (req, res, next) => {
  const authHeader = String(req.headers.authorization ?? "").trim();
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      type: "https://api.example.com/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Missing or malformed Authorization header. Expected: Bearer <token>",
      instance: req.originalUrl,
    });
    return;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    res.status(401).json({
      type: "https://api.example.com/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Token is empty",
      instance: req.originalUrl,
    });
    return;
  }
  try {
    const decoded = verifyToken(token);
    (req as any).credentialId = decoded.credentialId;
    (req as any).companyId = decoded.companyId;
    (req as any).accountId = decoded.accountId;
    next();
  } catch (err: any) {
    const status = Number(err?.status ?? 401);
    res.status(status).json({
      type: `https://api.example.com/problems/${status}`,
      title: status === 401 ? "Unauthorized" : "Forbidden",
      status,
      detail: err?.message ?? "Authentication failed",
      instance: req.originalUrl,
    });
  }
};

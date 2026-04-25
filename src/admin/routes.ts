import { Router } from "express";
import { simpleRateLimit } from "../middlewares/rate-limit.js";

export const adminRouter = Router();

adminRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "admin" }));

adminRouter.use(simpleRateLimit({ windowMs: 60_000, max: 600 }));

// TODO: auth middleware (AdminAuthProject) + RBAC
adminRouter.get("/dashboard/snapshot", (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
});

adminRouter.post("/dashboard/prepare-snapshot", (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
});

adminRouter.post("/onboarding/start", (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
});


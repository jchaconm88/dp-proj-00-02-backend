import { Router } from "express";

export const mobileRouter = Router();

mobileRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "mobile" }));


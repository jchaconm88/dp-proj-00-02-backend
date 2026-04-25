import { Router } from "express";

export const landingRouter = Router();

landingRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "landing" }));


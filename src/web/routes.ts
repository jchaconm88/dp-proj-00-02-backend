import { Router } from "express";

export const webRouter = Router();

webRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "web" }));

// TODO: endpoints para migración gradual callables -> HTTP (/rpc/*)


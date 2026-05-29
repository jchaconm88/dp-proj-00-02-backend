import "dotenv/config";
import express from "express";
import { adminRouter } from "./admin/routes.js";
import { webRouter } from "./web/routes.js";
import { landingRouter } from "./landing/routes.js";
import { mobileRouter } from "./mobile/routes.js";
import { integrationRouter } from "./integration/integration.router.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Coma (local) o | (útil en gcloud: --update-env-vars trocea por comas entre pares KEY=VALUE).
const corsOrigins = String(process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
  .split(/[,|]/)
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = String(req.headers.origin ?? "");
  const allowAnyOrigin = corsOrigins.includes("*");
  const allowThisOrigin = Boolean(origin) && corsOrigins.includes(origin);

  // Nota: `Access-Control-Allow-Credentials: true` NO es compatible con `Access-Control-Allow-Origin: *`
  if (allowAnyOrigin) {
    res.setHeader("access-control-allow-origin", "*");
  } else if (allowThisOrigin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-credentials", "true");
  }

  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key");
  if (req.method === "OPTIONS") return res.status(204).send();
  next();
});

app.use((_req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  next();
});

/** Siempre activo: confirma que el tráfico llega a este proceso (Vite proxy → PORT). */
app.use((req, _res, next) => {
  if (req.method === "OPTIONS") return next();
  const u = req.originalUrl ?? req.url ?? "";
  if (u.startsWith("/web") || u.startsWith("/admin")) {
    // eslint-disable-next-line no-console
    console.log(`[http] ${req.method} ${u}`);
  }
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.use("/admin", adminRouter);
app.use("/web", webRouter);
app.use("/api/v1", integrationRouter);
app.use("/landing", landingRouter);
app.use("/mobile", mobileRouter);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`dp-proj-00-02-backend listening on :${port} (cwd=${process.cwd()})`);
  // eslint-disable-next-line no-console
  console.log(
    `[http] WEB_API_DEBUG=${process.env.WEB_API_DEBUG ?? "(unset)"} — tráfico /web y /admin se registra con [http]`
  );
});


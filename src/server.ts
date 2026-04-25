import express from "express";
import { adminRouter } from "./admin/routes.js";
import { webRouter } from "./web/routes.js";
import { landingRouter } from "./landing/routes.js";
import { mobileRouter } from "./mobile/routes.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((_req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.use("/admin", adminRouter);
app.use("/web", webRouter);
app.use("/landing", landingRouter);
app.use("/mobile", mobileRouter);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`dp-proj-00-02-backend listening on :${port}`);
});


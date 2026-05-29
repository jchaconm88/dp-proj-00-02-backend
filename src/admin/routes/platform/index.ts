import { Router } from "express";
import accountsRouter from "./accounts.js";
import companiesRouter from "./companies.js";
import companyLocationsRouter from "./company-locations.js";
import adminAccessRouter from "./admin-access.js";
import companyUsersRouter from "./company-users.js";
import modulesRouter from "./modules.js";
import saasRouter from "./saas.js";
import ubigeosRouter from "./ubigeos.js";
import webRolesRouter from "./web-roles.js";
import webUsersRouter from "./web-users.js";
import integrationCredentialsRouter from "./integration-credentials.js";
import integrationWebhookOutboxRouter from "./integration-webhook-outbox.js";
import { loadIntegrationOpenApiSpec } from "../../../integration/load-openapi-spec.js";

const router = Router();

router.use("/accounts", accountsRouter);
router.use("/companies", companiesRouter);
router.use("/", companyLocationsRouter);
router.use("/", adminAccessRouter);
router.use("/", companyUsersRouter);
router.use("/", modulesRouter);
router.use("/", saasRouter);
router.use("/", ubigeosRouter);
router.use("/", webRolesRouter);
router.use("/web-users", webUsersRouter);
router.use("/integration-credentials", integrationCredentialsRouter);
router.use("/integration-webhook-outbox", integrationWebhookOutboxRouter);

router.get("/integration-openapi.json", (_req, res) => {
  try {
    const doc = loadIntegrationOpenApiSpec();
    res.setHeader("content-type", "application/json");
    res.status(200).json(doc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/platform/integration-openapi.json GET] failed:", msg);
    res.status(503).json({ error: "openapi_unavailable" });
  }
});

// Metadatos para Swagger UI en Admin (spec vía /integration-openapi.json + adminFetch)
router.get("/integration-api-meta", (_req, res) => {
  const publicApiBaseUrl = String(process.env.PUBLIC_API_BASE_URL ?? "").trim();
  res.status(200).json({
    publicApiBaseUrl: publicApiBaseUrl || "http://localhost:8080",
    openApiUrl: `${publicApiBaseUrl || "http://localhost:8080"}/api/v1/openapi.json`,
    adminOpenApiPath: "/admin/platform/integration-openapi.json",
    version: "1.0.0",
  });
});

export default router;

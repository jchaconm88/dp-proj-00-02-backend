import { Router } from "express";
import { problem } from "./integration-problem.js";
import { loadIntegrationOpenApiSpec } from "./load-openapi-spec.js";
import { integrationAuthMiddleware } from "./integration-auth.middleware.js";
import { integrationRateLimit } from "./integration-rate-limit.js";
import { authRouter } from "./routes/auth.routes.js";
import { catalogRouter } from "./routes/catalog.routes.js";
import { inventoryRouter } from "./routes/inventory.routes.js";
import { salesRouter } from "./routes/sales.routes.js";
import { logisticsRouter } from "./routes/logistics.routes.js";
import { billingRouter } from "./routes/billing.routes.js";
import { customersRouter } from "./routes/customers.routes.js";

export const integrationRouter = Router();

integrationRouter.use(integrationRateLimit);

integrationRouter.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

integrationRouter.get("/openapi.json", (_req, res) => {
  try {
    const doc = loadIntegrationOpenApiSpec();
    res.setHeader("content-type", "application/json");
    res.status(200).json(doc);
  } catch {
    res.status(503).json(problem(503, "OpenAPI spec not available", undefined, "/api/v1/openapi.json"));
  }
});

integrationRouter.use("/auth/token", authRouter);

integrationRouter.use(integrationAuthMiddleware);

integrationRouter.use("/products", catalogRouter);
integrationRouter.use("/inventory", inventoryRouter);
integrationRouter.use("/orders", salesRouter);
integrationRouter.use("/orders", billingRouter);
integrationRouter.use("/customers", customersRouter);
integrationRouter.use("/shipping", logisticsRouter);

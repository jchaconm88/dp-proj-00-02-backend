import { Router, type Request } from "express";
import { problem } from "../integration-problem.js";
import {
  createIntegrationOrder,
  updateIntegrationOrderStatus,
  registerIntegrationPayment,
  getIntegrationShipment,
  type IntegrationRequestContext,
} from "../integration-order.service.js";

export const salesRouter = Router();

function ctx(req: Request): IntegrationRequestContext {
  const r = req as any;
  return {
    companyId: String(r.companyId ?? ""),
    accountId: String(r.accountId ?? ""),
    credentialId: String(r.credentialId ?? ""),
  };
}

salesRouter.post("/", async (req, res) => {
  try {
    const result = await createIntegrationOrder(ctx(req), req.body ?? {});
    if (result.status === 409) {
      return res.status(409).json(result.body);
    }
    if (result.status >= 400) {
      return res.status(result.status).json(problem(result.status, String(result.body.detail ?? "Error"), undefined, req.originalUrl));
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    if (msg.startsWith("insufficient_stock:")) {
      return res.status(422).json(problem(422, msg.replace("insufficient_stock:", "Insufficient stock for SKU "), undefined, req.originalUrl));
    }
    console.error("[integration/orders POST] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

salesRouter.put("/:id/status", async (req, res) => {
  try {
    const status = String((req.body ?? {}).status ?? "").trim();
    if (!status) {
      return res.status(422).json(problem(422, "status is required", undefined, req.originalUrl));
    }
    const result = await updateIntegrationOrderStatus(ctx(req), req.params.id, status);
    if (result.status >= 400) {
      return res.status(result.status).json(problem(result.status, String(result.body.detail ?? "Error"), undefined, req.originalUrl));
    }
    return res.status(200).json(result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/orders/:id/status PUT] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

salesRouter.post("/:id/payments", async (req, res) => {
  try {
    const result = await registerIntegrationPayment(ctx(req), req.params.id, req.body ?? {});
    if (result.status >= 400) {
      return res.status(result.status).json(problem(result.status, String(result.body.detail ?? "Error"), undefined, req.originalUrl));
    }
    return res.status(200).json(result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/orders/:id/payments POST] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

salesRouter.get("/:id/shipment", async (req, res) => {
  try {
    const result = await getIntegrationShipment(ctx(req), req.params.id);
    if (result.status >= 400) {
      return res.status(result.status).json(problem(result.status, String(result.body.detail ?? "Error"), undefined, req.originalUrl));
    }
    return res.status(200).json(result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/orders/:id/shipment GET] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

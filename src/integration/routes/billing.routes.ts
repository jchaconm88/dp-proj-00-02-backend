import { Router, type Request } from "express";
import { problem } from "../integration-problem.js";
import { createIntegrationInvoice, type IntegrationRequestContext } from "../integration-order.service.js";

export const billingRouter = Router();

function ctx(req: Request): IntegrationRequestContext {
  const r = req as any;
  return {
    companyId: String(r.companyId ?? ""),
    accountId: String(r.accountId ?? ""),
    credentialId: String(r.credentialId ?? ""),
  };
}

billingRouter.post("/:id/invoice", async (req, res) => {
  try {
    const result = await createIntegrationInvoice(ctx(req), req.params.id, req.body ?? {});
    if (result.status >= 400) {
      return res.status(result.status).json(problem(result.status, String(result.body.detail ?? "Error"), undefined, req.originalUrl));
    }
    return res.status(200).json(result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/orders/:id/invoice POST] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

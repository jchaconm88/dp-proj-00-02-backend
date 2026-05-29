import { Router, type Request } from "express";
import { problem } from "../integration-problem.js";
import { calculateShippingRates, type IntegrationRequestContext } from "../integration-order.service.js";

export const logisticsRouter = Router();

function ctx(req: Request): IntegrationRequestContext {
  const r = req as any;
  return {
    companyId: String(r.companyId ?? ""),
    accountId: String(r.accountId ?? ""),
    credentialId: String(r.credentialId ?? ""),
  };
}

logisticsRouter.post("/rates", async (req, res) => {
  try {
    const result = await calculateShippingRates(ctx(req), req.body ?? {});
    return res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/shipping/rates POST] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

import { Router, type Request } from "express";
import { problem } from "../integration-problem.js";
import { upsertIntegrationCustomer, type IntegrationRequestContext } from "../integration-order.service.js";

export const customersRouter = Router();

function ctx(req: Request): IntegrationRequestContext {
  const r = req as any;
  return {
    companyId: String(r.companyId ?? ""),
    accountId: String(r.accountId ?? ""),
    credentialId: String(r.credentialId ?? ""),
  };
}

customersRouter.post("/", async (req, res) => {
  try {
    const body = req.body ?? {};
    const externalId = String(body.external_id ?? "").trim();
    if (!externalId && !String(body.email ?? "").trim()) {
      return res.status(422).json(problem(422, "external_id or email is required", undefined, req.originalUrl));
    }
    const { clientId, created } = await upsertIntegrationCustomer(ctx(req), body);
    return res.status(created ? 201 : 200).json({
      client_id: clientId,
      external_id: externalId || String(body.email ?? "").trim(),
      created,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/customers POST] failed:", msg);
    return res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

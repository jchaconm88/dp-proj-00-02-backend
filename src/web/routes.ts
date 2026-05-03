import { Router } from "express";
import { requireWebAuth } from "../middlewares/web-auth.js";
import { getWebFirestore } from "../lib/firebase-admin.js";
import {
  createCustomSequence,
  deleteCustomSequence,
  generateSequenceCode,
  getMergedSequenceById,
  listMergedSequences,
  updateCustomSequence,
} from "../lib/sequences.service.js";
import {
  createWebCustomRole,
  deleteWebCustomRole,
  getMergedWebRoleById,
  listMergedWebRoles,
  roleHttpStatus,
  updateWebCustomRole,
} from "../lib/merged-roles.service.js";

export const webRouter = Router();

webRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "web" }));

webRouter.use(requireWebAuth);

function webApiDebug(): boolean {
  const v = String(process.env.WEB_API_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function logWebApi(event: string, data: Record<string, unknown>): void {
  if (!webApiDebug()) return;
  // eslint-disable-next-line no-console
  console.log(`[web-api] ${event}`, data);
}

function sequenceHttpStatus(error: string): number {
  if (error === "default_sequence_readonly" || error === "entity_required" || error === "companyId_required") return 400;
  if (error === "sequence_entity_duplicate") return 409;
  if (error === "sequence_not_found") return 412;
  if (error === "not_found") return 404;
  return 500;
}

async function requireCompanyScope(req: any): Promise<{ uid: string; accountId: string; companyId: string }> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const companyId = String(req.query?.companyId ?? req.body?.companyId ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  logWebApi("requireCompanyScope:start", {
    companyId,
    uidPrefix: uid.length > 6 ? `${uid.slice(0, 6)}…` : uid,
  });
  const db = getWebFirestore();
  const companyUserSnap = await db
    .collection("company-users")
    .where("companyId", "==", companyId)
    .where("userId", "==", uid)
    .limit(1)
    .get();
  logWebApi("requireCompanyScope:company-users", { empty: companyUserSnap.empty, count: companyUserSnap.size });
  if (companyUserSnap.empty) {
    logWebApi("requireCompanyScope:forbidden", { reason: "no_company_user_doc", companyId });
    throw new Error("forbidden");
  }
  const data = companyUserSnap.docs[0]!.data();
  if (String(data.status ?? "active").trim() === "inactive") {
    logWebApi("requireCompanyScope:forbidden", { reason: "inactive_company_user", companyId });
    throw new Error("forbidden");
  }
  let accountId = String(data.accountId ?? "").trim();
  if (!accountId) {
    const company = await db.collection("companies").doc(companyId).get();
    accountId = String(company.data()?.accountId ?? companyId).trim() || companyId;
    logWebApi("requireCompanyScope:accountId-from-company", { companyId, accountId, companyExists: company.exists });
  }
  logWebApi("requireCompanyScope:ok", { companyId, accountId });
  return { uid, accountId, companyId };
}

webRouter.get("/system/web-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const items = await listMergedSequences(getWebFirestore(), "web", accountId, companyId);
    logWebApi("web-sequences GET ok", { companyId, itemCount: items.length });
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const item = await getMergedSequenceById(getWebFirestore(), "web", accountId, req.params.id, companyId);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const out = await createCustomSequence(getWebFirestore(), "web", accountId, req.body ?? {}, companyId);
    res.status(201).json({ ok: true, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.put("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await updateCustomSequence(getWebFirestore(), "web", accountId, req.params.id, req.body ?? {}, companyId);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.delete("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await deleteCustomSequence(getWebFirestore(), "web", accountId, req.params.id, companyId);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-sequences/generate-code", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const code = await generateSequenceCode(
      getWebFirestore(),
      "web",
      accountId,
      String(req.body?.entity ?? ""),
      String(req.body?.currentCode ?? ""),
      companyId
    );
    res.status(200).json({ code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences/generate-code POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-roles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const items = await listMergedWebRoles(getWebFirestore(), accountId, companyId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const item = await getMergedWebRoleById(getWebFirestore(), accountId, companyId, req.params.id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-roles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const { id } = await createWebCustomRole(getWebFirestore(), accountId, companyId, {
      ...(req.body ?? {}),
      createBy: "web",
      updateBy: "web",
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.put("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await updateWebCustomRole(getWebFirestore(), accountId, companyId, req.params.id, {
      ...(req.body ?? {}),
      updateBy: "web",
    });
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.delete("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await deleteWebCustomRole(getWebFirestore(), accountId, companyId, req.params.id);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});


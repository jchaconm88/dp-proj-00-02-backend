import { Router } from "express";
import { isWebDefaultRoleId } from "../../../data/web-roles.js";
import {
  createWebCustomRole,
  deleteWebCustomRole,
  getMergedWebRoleById,
  listMergedWebRoles,
  roleHttpStatus,
  updateWebCustomRole,
} from "../../../lib/merged-roles.service.js";
import { getWebFirestore } from "../../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

const router = Router();

router.get("/web-roles", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const companyId = String(req.query.companyId ?? "").trim();
    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    const wDb = getWebFirestore();
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const items = await listMergedWebRoles(wDb, accountId, companyId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    let companyId = String(req.query.companyId ?? "").trim();
    if (isWebDefaultRoleId(id) && !companyId) {
      return res.status(400).json({ error: "companyId_required" });
    }
    if (!isWebDefaultRoleId(id)) {
      const snap = await wDb.collection("roles").doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "not_found" });
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const item = await getMergedWebRoleById(wDb, accountId, companyId, id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/web-roles", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { companyId, name } = req.body ?? {};
    const cid = String(companyId ?? "").trim();
    if (!cid || !name) return res.status(400).json({ error: "companyId_and_name_required" });
    const company = await wDb.collection("companies").doc(cid).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const { id } = await createWebCustomRole(wDb, accountId, cid, {
      ...(req.body ?? {}),
      createBy: "admin",
      updateBy: "admin",
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles POST] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

router.put("/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    const snap = await wDb.collection("roles").doc(id).get();
    if (!snap.exists && !isWebDefaultRoleId(id)) return res.status(404).json({ error: "not_found" });
    let companyId = String(req.query.companyId ?? (req.body as any)?.companyId ?? "").trim();
    if (!isWebDefaultRoleId(id)) {
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    } else {
      if (!companyId) return res.status(400).json({ error: "companyId_required" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await updateWebCustomRole(wDb, accountId, companyId, id, { ...(req.body ?? {}), updateBy: "admin" });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles PUT] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

router.delete("/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    let companyId = String(req.query.companyId ?? "").trim();
    if (!isWebDefaultRoleId(id)) {
      const snap = await wDb.collection("roles").doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "not_found" });
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    } else {
      if (!companyId) return res.status(400).json({ error: "companyId_required" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await deleteWebCustomRole(wDb, accountId, companyId, id);
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles DELETE] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

export default router;


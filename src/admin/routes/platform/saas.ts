import { Router } from "express";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

const router = Router();

// ─── Plans CRUD ──────────────────────────────────────────────────────────────

router.get("/plans", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("saas-plans").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, name, planId, active = true, limits, features, ...rest } = req.body ?? {};
    if (!id || !name) return res.status(400).json({ error: "id_and_name_required" });
    await db.collection("saas-plans").doc(String(id).trim()).set({
      name: String(name).trim(),
      planId: String(planId ?? id).trim(),
      accountId,
      active: Boolean(active),
      ...(limits !== undefined && { limits }),
      ...(features !== undefined && { features }),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/plans/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    const existing = await db.collection("saas-plans").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("saas-plans").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/plans/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("saas-plans").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("saas-plans").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Subscriptions CRUD ──────────────────────────────────────────────────────

router.get("/subscriptions", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("subscriptions").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/subscriptions", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, planId, status = "active", ...rest } = req.body ?? {};
    if (!id || !planId) return res.status(400).json({ error: "id_and_planId_required" });
    await db.collection("subscriptions").doc(String(id).trim()).set({
      accountId,
      planId: String(planId).trim(),
      status: String(status),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/subscriptions/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    const existing = await db.collection("subscriptions").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("subscriptions").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/subscriptions/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("subscriptions").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("subscriptions").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


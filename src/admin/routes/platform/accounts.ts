import { Router } from "express";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("accounts").doc(accountId).get();
    const items = snap.exists ? [{ id: snap.id, ...snap.data() }] : [];
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { name, status = "active", ...rest } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name_required" });
    await db.collection("accounts").doc(accountId).set({
      name: String(name).trim(),
      status: String(status),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id: accountId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    await db.collection("accounts").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    await db.collection("accounts").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

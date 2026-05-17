import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import { requireAdminAuth } from "../../../middlewares/admin-auth.js";

const router = Router();

router.use(requireAdminAuth);

function toCounterRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = (doc.data() ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    sequenceId: String(d.sequenceId ?? ""),
    counter: Number(d.counter) || 0,
    description: d.description ? String(d.description) : undefined,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

router.get("/counters", async (req, res) => {
  try {
    const sequenceId = String(req.query?.sequenceId ?? "").trim();
    const db = getWebFirestore();
    let query: FirebaseFirestore.Query = db.collection("counters");
    if (sequenceId) {
      query = query.where("sequenceId", "==", sequenceId);
    }
    const snap = await query.get();
    const items = snap.docs.map(toCounterRecord);
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/counters GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/counters/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    const snap = await db.collection("counters").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toCounterRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/counters/:id GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/counters", async (req, res) => {
  try {
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sequenceId = String(body.sequenceId ?? "").trim();
    if (!sequenceId) return res.status(400).json({ error: "validation_error", message: "sequenceId is required" });

    const now = new Date();
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    const docRef = db.collection("counters").doc();
    await docRef.set({
      sequenceId,
      counter: Number(body.counter) || 0,
      description: String(body.description ?? "").trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createBy: uid,
    });
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/counters POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/counters/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("counters").doc(id).get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date(), updateBy: String((req as any)?.auth?.uid ?? "").trim() };
    if (body.sequenceId !== undefined) patch.sequenceId = String(body.sequenceId ?? "").trim();
    if (body.counter !== undefined) patch.counter = Number(body.counter) || 0;
    if (body.description !== undefined) {
      const trimmed = String(body.description ?? "").trim();
      patch.description = trimmed || null;
    }
    await db.collection("counters").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/counters/:id PUT] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/counters/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("counters").doc(id).get();
    if (!existing.exists) return res.status(200).json({ ok: true });
    await db.collection("counters").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/counters/:id DELETE] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

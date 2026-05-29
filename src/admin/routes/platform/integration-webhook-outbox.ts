import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import { processOutbox } from "../../../integration/integration-webhook.dispatcher.js";

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
    const companyId = String(req.query.companyId ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const db = getWebFirestore();

    let query: FirebaseFirestore.Query = db.collection("integration-webhook-outbox")
      .where("accountId", "==", accountId);
    if (companyId) query = query.where("companyId", "==", companyId);
    if (status) query = query.where("status", "==", status);
    query = query.orderBy("createdAt", "desc").limit(100);

    const snap = await query.get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-webhook-outbox GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/:id/retry", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("integration-webhook-outbox").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data()!;
    if (String(data.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("integration-webhook-outbox").doc(id).update({
      status: "pending",
      attempts: 0,
      lastError: "",
      nextRetryAt: new Date(),
    });
    setImmediate(() => { processOutbox().catch(() => {}); });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-webhook-outbox retry] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

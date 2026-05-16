import { Router } from "express";
import { getAdminFirestore, getWebFirestore } from "../../../lib/firebase-admin.js";
import { rebuildAdminEntitySearchIndexForAccount } from "../../../features/search/entity-search-index-admin.service.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

const COLLECTION = "entity-search-indexes-admin";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = String(req.query.accountId ?? "").trim() || requireAccountId(req);
    const adminDb = getAdminFirestore();
    const snap = await adminDb.collection(COLLECTION).doc(accountId).get();
    if (!snap.exists) {
      return res.status(200).json({ accountId, updatedAt: null, entities: {} });
    }
    const data = snap.data() ?? {};
    res.status(200).json({
      accountId,
      updatedAt: data.updatedAt ?? null,
      entities: data.entities ?? {},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/entity-search-index GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/rebuild", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = String(req.query.accountId ?? "").trim() || requireAccountId(req);
    const adminDb = getAdminFirestore();
    const webDb = getWebFirestore();
    const summary = await rebuildAdminEntitySearchIndexForAccount(adminDb, webDb, { accountId });
    res.status(200).json({ ok: true, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/entity-search-index/rebuild POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

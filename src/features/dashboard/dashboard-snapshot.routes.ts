import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { buildSnapshotDocId, compose } from "./snapshot-composer.service.js";

const router = Router();

// ─── GET /snapshot (Web: query companyId, period) ────────────────────────────

/**
 * Fetches the pre-computed dashboard snapshot for a company/period.
 * The accountId is derived from the company document.
 */
router.get("/snapshot", async (req, res) => {
  try {
    const companyId = String(req.query.companyId ?? "").trim();
    const period = String(req.query.period ?? "").trim();

    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });

    const db = getWebFirestore();

    // Derive accountId from the company document
    const companySnap = await db.collection("companies").doc(companyId).get();
    const accountId = String(companySnap.data()?.accountId ?? companyId).trim() || companyId;

    const docId = buildSnapshotDocId(accountId, companyId, period);
    const snap = await db.collection("dashboard-snapshots").doc(docId).get();

    if (!snap.exists) {
      return res.status(200).json({
        period,
        cards: [],
        charts: [],
        activityItems: [],
        metadata: null,
      });
    }

    const data = snap.data() ?? {};
    return res.status(200).json({
      period: String((data as any).period ?? period),
      cards: Array.isArray((data as any).cards) ? (data as any).cards : [],
      charts: Array.isArray((data as any).charts) ? (data as any).charts : [],
      activityItems: Array.isArray((data as any).activityItems) ? (data as any).activityItems : [],
      metadata: (data as any).metadata ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard/snapshot GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── POST /recompose (Admin: body accountId, companyId?, period?) ─────────────

/**
 * Forces recomposition of a dashboard snapshot for a given tenant/period.
 * Called from admin to trigger on-demand snapshot rebuild.
 */
router.post("/recompose", async (req, res) => {
  try {
    const accountId = String(req.body?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId_required" });

    const companyId = String(req.body?.companyId ?? "").trim() || undefined;
    const period = String(req.body?.period ?? "").trim() || undefined;

    if (period && !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period_invalid" });
    }

    const db = getWebFirestore();
    await compose(db, { accountId, companyId, period });

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[dashboard/recompose POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

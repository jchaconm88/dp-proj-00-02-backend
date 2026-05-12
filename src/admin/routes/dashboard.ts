import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { buildSnapshotDocId, compose } from "../../features/dashboard/snapshot-composer.service.js";

const router = Router();

router.get("/snapshot", async (req, res) => {
  const accountId = String(req.query.accountId ?? "").trim();
  const period = String(req.query.period ?? "").trim();
  if (!accountId) return res.status(400).json({ error: "accountId_required" });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });

  const docId = buildSnapshotDocId(accountId, null, period);
  const snap = await getWebFirestore().collection("dashboard-snapshots").doc(docId).get();

  // If snapshot doesn't exist yet (e.g. new accounts), return empty structure.
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
  res.status(200).json({
    period: String((data as any).period ?? period),
    cards: Array.isArray((data as any).cards) ? (data as any).cards : [],
    charts: Array.isArray((data as any).charts) ? (data as any).charts : [],
    activityItems: Array.isArray((data as any).activityItems) ? (data as any).activityItems : [],
    metadata: (data as any).metadata ?? null,
  });
});

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
    console.error("[admin/dashboard/recompose POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/prepare-snapshot", async (_req, res) => {
  // Legacy: kept for backward compatibility. Snapshot is now composed via /recompose.
  res.status(200).json({ ok: true });
});

export default router;

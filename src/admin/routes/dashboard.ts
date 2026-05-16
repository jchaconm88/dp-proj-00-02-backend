import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { compose } from "../../features/dashboard/snapshot-composer.service.js";
import { buildSnapshotDocId } from "../../features/dashboard/dashboard-utils.js";
import { filterByPermission, filterByTarget } from "../../features/dashboard/dashboard-filters.js";
import type { SnapshotDocument, SnapshotCardEntry, SnapshotChartEntry } from "../../features/dashboard/dashboard.types.js";

const router = Router();

router.get("/snapshot", async (req, res) => {
  const accountId = String(req.query.accountId ?? "").trim();
  const period = String(req.query.period ?? "").trim();
  if (!accountId) return res.status(400).json({ error: "accountId_required" });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });

  const docId = buildSnapshotDocId(accountId, null, period);
  const snap = await getWebFirestore().collection("dashboard-snapshots").doc(docId).get();

  if (!snap.exists) {
    return res.status(200).json({
      accountId,
      companyId: null,
      period,
      cards: [],
      charts: [],
      counters: {},
      activityItems: [],
      metadata: null,
    });
  }

  const data = snap.data() as SnapshotDocument;
  const effectivePermissions: string[] = (req as any).effectivePermissions ?? [];

  let cards = Object.values(data.cards ?? {});
  if (effectivePermissions.length > 0) {
    cards = filterByPermission(cards, effectivePermissions) as SnapshotCardEntry[];
  }
  cards = filterByTarget(cards, "admin") as SnapshotCardEntry[];
  cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let charts = Object.values(data.charts ?? {});
  if (effectivePermissions.length > 0) {
    charts = filterByPermission(charts, effectivePermissions) as SnapshotChartEntry[];
  }
  charts = filterByTarget(charts, "admin") as SnapshotChartEntry[];

  res.status(200).json({
    accountId: data.accountId,
    companyId: data.companyId,
    period: data.period,
    cards,
    charts,
    counters: data.counters ?? {},
    activityItems: data.activityItems ?? [],
    metadata: data.metadata ?? null,
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

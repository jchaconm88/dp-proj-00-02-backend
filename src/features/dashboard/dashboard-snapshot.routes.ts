import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { compose } from "./snapshot-composer.service.js";
import { buildSnapshotDocId } from "./dashboard-utils.js";
import { filterByPermission, filterByTarget, mergeWithOverrides } from "./dashboard-filters.js";
import type { SnapshotDocument, SnapshotCardEntry, SnapshotChartEntry, DashboardSnapshotResponse } from "./dashboard.types.js";

const router = Router();

// ─── Transform: maps → arrays ────────────────────────────────────────────────

function transformSnapshotToResponse(
  doc: SnapshotDocument,
  effectivePermissions: string[],
  appTarget: "admin" | "web",
  overrides: Array<{ definitionId: string; definitionType: string; visible: boolean; order: number }> | null
): DashboardSnapshotResponse {
  // Filter cards
  let filteredCards = Object.values(doc.cards ?? {}) as SnapshotCardEntry[];

  if (effectivePermissions.length > 0) {
    filteredCards = filterByPermission(filteredCards, effectivePermissions);
  }
  filteredCards = filterByTarget(filteredCards, appTarget);

  // Apply overrides
  if (overrides && overrides.length > 0) {
    const withVisibility = filteredCards.map((card) => ({
      ...card,
      id: card.cardKey,
      visible: true,
    }));
    const merged = mergeWithOverrides(
      withVisibility,
      overrides.filter(
        (ov): ov is { definitionId: string; definitionType: "card" | "chart"; visible: boolean; order: number } =>
          ov.definitionType === "card" || ov.definitionType === "chart"
      )
    );
    filteredCards = merged
      .filter((card) => card.visible)
      .map(({ visible: _visible, ...card }) => card);
  }

  // Sort by order
  filteredCards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Filter charts
  let filteredCharts = Object.values(doc.charts ?? {});
  if (effectivePermissions.length > 0) {
    filteredCharts = filterByPermission(filteredCharts, effectivePermissions) as SnapshotChartEntry[];
  }
  filteredCharts = filterByTarget(filteredCharts, appTarget) as SnapshotChartEntry[];

  return {
    accountId: doc.accountId,
    companyId: doc.companyId,
    period: doc.period,
    cards: filteredCards,
    charts: filteredCharts,
    counters: doc.counters ?? {},
    activityItems: doc.activityItems ?? [],
    metadata: doc.metadata ?? null,
  };
}

// ─── GET /snapshot (Web: query companyId, period) ────────────────────────────

router.get("/snapshot", async (req, res) => {
  try {
    const companyId = String(req.query.companyId ?? "").trim();
    const period = String(req.query.period ?? "").trim();

    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });

    const db = getWebFirestore();

    const companySnap = await db.collection("companies").doc(companyId).get();
    const accountId = String(companySnap.data()?.accountId ?? companyId).trim() || companyId;

    const docId = buildSnapshotDocId(accountId, companyId, period);
    const snap = await db.collection("dashboard-snapshots").doc(docId).get();

    if (!snap.exists) {
      return res.status(200).json({
        accountId,
        companyId,
        period,
        cards: [],
        charts: [],
        counters: {},
        activityItems: [],
        metadata: null,
      });
    }

    const data = snap.data() as SnapshotDocument;

    // Resolve effective permissions from the request
    const effectivePermissions: string[] = (req as any).effectivePermissions ?? [];
    const appTarget: "admin" | "web" = "web";

    // Read overrides from company-dashboard-overrides
    let overrides: any = null;
    try {
      const overridesSnap = await db.collection("company-dashboard-overrides").doc(companyId).get();
      if (overridesSnap.exists) {
        overrides = (overridesSnap.data() as any)?.entries ?? null;
      }
    } catch {
      overrides = null;
    }

    const response = transformSnapshotToResponse(data, effectivePermissions, appTarget, overrides);
    return res.status(200).json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard/snapshot GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── GET /snapshot (Admin: query accountId, period) ──────────────────────────

/**
 * Admin snapshot endpoint. Mounted at /admin/dashboard/snapshot.
 * Expects accountId and period as query params.
 */
router.get("/admin/snapshot", async (req, res) => {
  try {
    const accountId = String(req.query.accountId ?? "").trim();
    const period = String(req.query.period ?? "").trim();

    if (!accountId) return res.status(400).json({ error: "accountId_required" });
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });

    const db = getWebFirestore();

    const docId = buildSnapshotDocId(accountId, null, period);
    const snap = await db.collection("dashboard-snapshots").doc(docId).get();

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
    const appTarget: "admin" | "web" = "admin";

    const response = transformSnapshotToResponse(data, effectivePermissions, appTarget, null);
    return res.status(200).json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/dashboard/snapshot GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── POST /recompose (body: accountId?, companyId?, period?) ─────────────────

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

// ─── POST /web/dashboard/recompose (body: companyId, period?) ────────────────

/**
 * Web-facing recompose endpoint. Derives accountId from companyId.
 */
router.post("/web/recompose", async (req, res) => {
  try {
    const companyId = String(req.body?.companyId ?? "").trim();
    if (!companyId) return res.status(400).json({ error: "companyId_required" });

    const period = String(req.body?.period ?? "").trim() || undefined;
    if (period && !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "period_invalid" });
    }

    const db = getWebFirestore();
    const companySnap = await db.collection("companies").doc(companyId).get();
    if (!companySnap.exists) return res.status(404).json({ error: "company_not_found" });

    const accountId = String(companySnap.data()?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId_derivation_failed" });

    await compose(db, { accountId, companyId, period });
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard/recompose POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

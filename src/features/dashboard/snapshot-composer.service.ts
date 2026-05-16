import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { listMergedMetrics, listMergedCards, listMergedCharts } from "./dashboard-catalog.service.js";
import { recalculate } from "./tenant-stats.service.js";
import { filterActiveVisible } from "./dashboard-filters.js";
import { formatValue, computeRatioProgress, buildSnapshotDocId, getCurrentPeriod } from "./dashboard-utils.js";
import type {
  MetricDefinition,
  CardDefinition,
  ChartDefinition,
  DashboardSnapshot,
  SnapshotCard,
  SnapshotCardEntry,
  SnapshotChartEntry,
  SnapshotDocument,
  ChartDataPoint,
  TenantStats,
  MergedDefinition,
} from "./dashboard.types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAPSHOTS_COLLECTION = "dashboard-snapshots";
const CHART_DATA_POINTS_COLLECTION = "chart-data-points";
const TENANT_STATS_COLLECTION = "tenant-stats";
const MAX_CHART_PERIODS = 12;

// ─── compose (maps-based) ─────────────────────────────────────────────────────

/**
 * Recomposes the dashboard snapshot for a given tenant/period.
 * Generates the new unified format (SnapshotDocument) with maps instead of arrays.
 */
export async function compose(
  db: FirebaseFirestore.Firestore,
  params: { accountId: string; companyId?: string; period?: string }
): Promise<void> {
  const { accountId, companyId } = params;
  const period = params.period || getCurrentPeriod();

  // 1. Read merged definitions
  const [mergedMetrics, mergedCards, mergedCharts] = await Promise.all([
    listMergedMetrics(db),
    listMergedCards(db),
    listMergedCharts(db),
  ]);

  // 2. Read tenant-stats
  const tenantStats = await recalculate(db, { accountId, companyId });

  // 3. Build metrics lookup
  const metricsMap = new Map<string, MetricDefinition>();
  for (const m of mergedMetrics) {
    metricsMap.set(m.data.metricKey, m.data);
  }

  // 4. Build counters map
  const counters: Record<string, number> = { ...tenantStats.counters };

  // 5. Build history map from chart-data-points
  let history: Record<string, Record<string, number>> = {};
  try {
    let chartDataPointsQuery = db
      .collection(CHART_DATA_POINTS_COLLECTION)
      .where("accountId", "==", accountId);
    if (companyId) {
      chartDataPointsQuery = chartDataPointsQuery.where("companyId", "==", companyId);
    } else {
      chartDataPointsQuery = chartDataPointsQuery.where("companyId", "==", null);
    }
    const chartDataSnap = await chartDataPointsQuery.get();
    for (const doc of chartDataSnap.docs) {
      const dp = doc.data() as ChartDataPoint;
      if (!history[dp.metricKey]) history[dp.metricKey] = {};
      history[dp.metricKey][dp.period] = dp.value;
    }
  } catch {
    // If chart-data-points query fails, start with empty history
    history = {};
  }

  // 6. Build cards map
  const activeCards = filterActiveVisible(
    mergedCards.map((c) => c.data)
  ) as CardDefinition[];

  const cardsMap: Record<string, SnapshotCardEntry> = {};
  for (const card of activeCards) {
    const metric = metricsMap.get(card.metricKey);
    if (!metric) continue;

    const rawValue = counters[card.metricKey] ?? 0;
    const valueFormat = metric.valueFormat ?? "number";

    let progressPct: number | null = null;
    let progressLabel: string | null = null;

    if (metric.type === "ratio" && metric.numeratorMetricKey && metric.denominatorMetricKey) {
      const numerator = counters[metric.numeratorMetricKey] ?? 0;
      const denominator = counters[metric.denominatorMetricKey] ?? 0;
      progressPct = computeRatioProgress(numerator, denominator);
      progressLabel = `${numerator} / ${denominator}`;
    }

    cardsMap[card.cardKey] = {
      cardKey: card.cardKey,
      metricKey: card.metricKey,
      title: card.title,
      subtitle: null,
      icon: card.icon,
      accentClass: card.accentClass,
      value: formatValue(rawValue, valueFormat),
      rawValue,
      progressPct,
      progressLabel,
      href: null,
      permissionModule: card.permissionModule ?? null,
      target: card.target,
      order: card.order,
    };
  }

  // 7. Build charts map
  const activeCharts = filterActiveVisible(
    mergedCharts.map((c) => ({ ...c.data, visible: true }))
  ) as (ChartDefinition & { visible: boolean })[];
  const currentPeriodCounters: Record<string, number> = { ...counters };

  const chartsMap: Record<string, SnapshotChartEntry> = {};
  for (const chart of activeCharts) {
    const chartType = chart.chartType;
    const metricKeys = chart.metricKeys;
    let labels: string[] = [];
    const datasets: Array<{ metricKey: string; label: string; data: number[] }> = [];

    if (chartType === "line" || chartType === "bar") {
      const periodsSet = new Set<string>();
      for (const mk of metricKeys) {
        const mh = history[mk] ?? {};
        for (const p of Object.keys(mh)) {
          periodsSet.add(p);
        }
      }
      labels = Array.from(periodsSet).sort().slice(-MAX_CHART_PERIODS);

      for (const mk of metricKeys) {
        const metric = metricsMap.get(mk);
        const metricLabel = metric?.label ?? mk;
        const mh = history[mk] ?? {};
        const data = labels.map((p) => mh[p] ?? 0);
        datasets.push({ metricKey: mk, label: metricLabel, data });
      }
    } else {
      labels = metricKeys.map((mk) => {
        const metric = metricsMap.get(mk);
        return metric?.label ?? mk;
      });
      const data = metricKeys.map((mk) => currentPeriodCounters[mk] ?? 0);
      datasets.push({
        metricKey: metricKeys.join(","),
        label: chart.title,
        data,
      });
    }

    chartsMap[chart.chartKey] = {
      chartKey: chart.chartKey,
      title: chart.title,
      chartType,
      permissionModule: chart.permissionModule ?? null,
      target: chart.target,
      labels,
      datasets,
    };
  }

  // 8. Build SnapshotDocument (maps-based)
  const docId = buildSnapshotDocId(accountId, companyId ?? null, period);

  const snapshot: Omit<SnapshotDocument, "updatedAt"> & { activityItems: any[] } = {
    accountId,
    companyId: companyId ?? null,
    period,
    counters,
    cards: cardsMap,
    charts: chartsMap,
    history,
    activityItems: [],
    metadata: {
      generatedAt: FieldValue.serverTimestamp() as any,
      configSource: "compose",
    },
  };

  await db.collection(SNAPSHOTS_COLLECTION).doc(docId).set({
    ...snapshot,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ─── selectiveRecompose ──────────────────────────────────────────────────────

/**
 * Recomposes only tenants that have an existing snapshot for the current period.
 * More efficient than recomposeAllAffected() which iterated all tenant-stats docs.
 */
export async function selectiveRecompose(
  db: FirebaseFirestore.Firestore
): Promise<{ recomposed: number; failed: number }> {
  const period = getCurrentPeriod();

  const snapshotsSnap = await db
    .collection(SNAPSHOTS_COLLECTION)
    .where("period", "==", period)
    .select("accountId", "companyId")
    .get();

  let recomposed = 0;
  let failed = 0;

  for (const doc of snapshotsSnap.docs) {
    const data = doc.data() as { accountId: string; companyId?: string | null };
    try {
      await compose(db, {
        accountId: data.accountId,
        companyId: data.companyId ?? undefined,
        period,
      });
      recomposed++;
    } catch (error) {
      console.error(
        `[selective-recompose] Failed for ${data.accountId}/${data.companyId ?? "no-company"}:`,
        error
      );
      failed++;
    }
  }

  return { recomposed, failed };
}

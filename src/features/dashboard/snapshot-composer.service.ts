import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { listMergedMetrics, listMergedCards, listMergedCharts } from "./dashboard-catalog.service.js";
import { recalculate } from "./tenant-stats.service.js";
import { filterActiveVisible } from "./dashboard-filters.js";
import type {
  MetricDefinition,
  CardDefinition,
  ChartDefinition,
  DashboardSnapshot,
  SnapshotCard,
  SnapshotChart,
  ChartDataPoint,
  TenantStats,
  MergedDefinition,
} from "./dashboard.types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const SNAPSHOTS_COLLECTION = "dashboard-snapshots";
const CHART_DATA_POINTS_COLLECTION = "chart-data-points";
const TENANT_STATS_COLLECTION = "tenant-stats";
const MAX_CHART_PERIODS = 12;

// ─── buildSnapshotDocId ──────────────────────────────────────────────────────

/**
 * Generates the document ID for a dashboard snapshot.
 * - If companyId is null/undefined/empty: `{accountId}___{period}` (triple underscore)
 * - Otherwise: `{accountId}_{companyId}_{period}`
 */
export function buildSnapshotDocId(
  accountId: string,
  companyId: string | null | undefined,
  period: string
): string {
  if (!companyId) {
    return `${accountId}___${period}`;
  }
  return `${accountId}_${companyId}_${period}`;
}

// ─── computeRatioProgress ────────────────────────────────────────────────────

/**
 * Calculates progressPct for ratio metrics.
 * - If denominator is 0, returns 0
 * - Calculates (numerator / denominator) * 100
 * - Clamps result between 0 and 100
 * - Rounds to nearest integer
 */
export function computeRatioProgress(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const raw = (numerator / denominator) * 100;
  const clamped = Math.max(0, Math.min(100, raw));
  return Math.round(clamped);
}

// ─── pruneChartDataPoints ────────────────────────────────────────────────────

/**
 * Retains at most 12 periods per metric/tenant combination.
 * Groups by `{accountId}_{companyId}_{metricKey}`, sorts each group
 * by period descending, and keeps only the most recent 12.
 */
export function pruneChartDataPoints(dataPoints: ChartDataPoint[]): ChartDataPoint[] {
  const groups = new Map<string, ChartDataPoint[]>();

  for (const dp of dataPoints) {
    const key = `${dp.accountId}_${dp.companyId ?? ""}_${dp.metricKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(dp);
    } else {
      groups.set(key, [dp]);
    }
  }

  const result: ChartDataPoint[] = [];
  for (const [, group] of groups) {
    // Sort by period descending (YYYY-MM format sorts lexicographically)
    group.sort((a, b) => b.period.localeCompare(a.period));
    // Keep only the most recent 12
    result.push(...group.slice(0, MAX_CHART_PERIODS));
  }

  return result;
}

// ─── Value Formatting ────────────────────────────────────────────────────────

function formatValue(rawValue: number, valueFormat: string): string {
  switch (valueFormat) {
    case "currency":
      return `$${rawValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "percentage":
      return `${rawValue}%`;
    case "bytes": {
      if (rawValue < 1024) return `${rawValue} B`;
      if (rawValue < 1024 * 1024) return `${(rawValue / 1024).toFixed(1)} KB`;
      if (rawValue < 1024 * 1024 * 1024) return `${(rawValue / (1024 * 1024)).toFixed(1)} MB`;
      return `${(rawValue / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    case "number":
    default:
      return rawValue.toLocaleString("en-US");
  }
}

// ─── getCurrentPeriod ────────────────────────────────────────────────────────

function getCurrentPeriod(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// ─── compose ─────────────────────────────────────────────────────────────────

/**
 * Recomposes the dashboard snapshot for a given tenant/period.
 * Reads merged definitions, tenant-stats, and chart-data-points,
 * then builds and persists the snapshot document.
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

  // 3. Read existing chart-data-points for this tenant
  let chartDataPointsQuery = db
    .collection(CHART_DATA_POINTS_COLLECTION)
    .where("accountId", "==", accountId);

  if (companyId) {
    chartDataPointsQuery = chartDataPointsQuery.where("companyId", "==", companyId);
  } else {
    chartDataPointsQuery = chartDataPointsQuery.where("companyId", "==", null);
  }

  const chartDataSnap = await chartDataPointsQuery.get();
  const existingDataPoints: ChartDataPoint[] = chartDataSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as ChartDataPoint[];

  // 4. Build metrics lookup
  const metricsMap = new Map<string, MetricDefinition>();
  for (const m of mergedMetrics) {
    metricsMap.set(m.data.metricKey, m.data);
  }

  // 5. Build SnapshotCards from active cards
  const activeCards = filterActiveVisible(
    mergedCards.map((c) => c.data)
  ) as CardDefinition[];

  const snapshotCards: SnapshotCard[] = [];
  for (const card of activeCards) {
    const metric = metricsMap.get(card.metricKey);
    if (!metric) continue; // Skip cards with missing metrics

    const rawValue = tenantStats.counters[card.metricKey] ?? 0;
    const valueFormat = metric.valueFormat ?? "number";

    let progressPct: number | null = null;
    let progressLabel: string | null = null;

    if (metric.type === "ratio" && metric.numeratorMetricKey && metric.denominatorMetricKey) {
      const numerator = tenantStats.counters[metric.numeratorMetricKey] ?? 0;
      const denominator = tenantStats.counters[metric.denominatorMetricKey] ?? 0;
      progressPct = computeRatioProgress(numerator, denominator);
      progressLabel = `${numerator} / ${denominator}`;
    }

    const snapshotCard: SnapshotCard = {
      id: card.id ?? card.cardKey,
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
    };

    snapshotCards.push(snapshotCard);
  }

  // 6. Build SnapshotCharts from active charts
  const activeCharts = filterActiveVisible(
    mergedCharts.map((c) => ({ ...c.data, visible: true }))
  ) as (ChartDefinition & { visible: boolean })[];

  // Update chart-data-points with current period values
  const currentPeriodDataPoints: ChartDataPoint[] = [];
  for (const metric of mergedMetrics) {
    if (!metric.data.active) continue;
    const value = tenantStats.counters[metric.data.metricKey] ?? 0;
    const dpId = `${accountId}_${companyId ?? ""}_${metric.data.metricKey}_${period}`;

    currentPeriodDataPoints.push({
      id: dpId,
      accountId,
      companyId: companyId ?? null,
      metricKey: metric.data.metricKey,
      period,
      value,
      createdAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
    });
  }

  // Merge existing data points with current period (replace if same period exists)
  const allDataPoints = [
    ...existingDataPoints.filter(
      (dp) => dp.period !== period
    ),
    ...currentPeriodDataPoints,
  ];

  // Prune to max 12 periods per metric/tenant
  const prunedDataPoints = pruneChartDataPoints(allDataPoints);

  // Build chart snapshots
  const snapshotCharts: SnapshotChart[] = [];
  for (const chart of activeCharts) {
    const chartType = chart.chartType;
    const metricKeys = chart.metricKeys;

    let labels: string[] = [];
    const datasets: Array<{ metricKey: string; label: string; data: number[] }> = [];

    if (chartType === "line" || chartType === "bar") {
      // Time-series: use chart-data-points for labels and datasets (last 12 periods)
      // Get all periods available for this chart's metrics
      const relevantPoints = prunedDataPoints.filter(
        (dp) => metricKeys.includes(dp.metricKey)
      );

      // Collect unique periods sorted ascending
      const periodsSet = new Set<string>();
      for (const dp of relevantPoints) {
        periodsSet.add(dp.period);
      }
      labels = Array.from(periodsSet).sort().slice(-MAX_CHART_PERIODS);

      // Build datasets
      for (const metricKey of metricKeys) {
        const metric = metricsMap.get(metricKey);
        const metricLabel = metric?.label ?? metricKey;
        const data = labels.map((p) => {
          const point = relevantPoints.find(
            (dp) => dp.metricKey === metricKey && dp.period === p
          );
          return point?.value ?? 0;
        });
        datasets.push({ metricKey, label: metricLabel, data });
      }
    } else {
      // Pie/doughnut: use current period values
      labels = metricKeys.map((mk) => {
        const metric = metricsMap.get(mk);
        return metric?.label ?? mk;
      });

      const data = metricKeys.map((mk) => tenantStats.counters[mk] ?? 0);
      datasets.push({
        metricKey: metricKeys.join(","),
        label: chart.title,
        data,
      });
    }

    const snapshotChart: SnapshotChart = {
      id: chart.id ?? chart.chartKey,
      chartKey: chart.chartKey,
      title: chart.title,
      chartType,
      permissionModule: chart.permissionModule ?? null,
      target: chart.target,
      labels,
      datasets,
    };

    snapshotCharts.push(snapshotChart);
  }

  // 7. Build DashboardSnapshot document
  const docId = buildSnapshotDocId(accountId, companyId ?? null, period);

  const snapshot: Omit<DashboardSnapshot, "id"> = {
    accountId,
    companyId: companyId ?? null,
    period,
    cards: snapshotCards.slice(0, 50), // Max 50 cards
    charts: snapshotCharts.slice(0, 20), // Max 20 charts
    activityItems: [], // Activity items are populated separately
    metadata: {
      generatedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
      configSource: "auto",
    },
    updatedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
  };

  // 8. Persist snapshot
  await db.collection(SNAPSHOTS_COLLECTION).doc(docId).set(snapshot);

  // 9. Persist chart-data-points (batch write)
  await persistChartDataPoints(db, prunedDataPoints, accountId, companyId ?? null);
}

// ─── persistChartDataPoints ──────────────────────────────────────────────────

async function persistChartDataPoints(
  db: FirebaseFirestore.Firestore,
  dataPoints: ChartDataPoint[],
  accountId: string,
  companyId: string | null
): Promise<void> {
  // Delete existing data points for this tenant, then write the pruned set
  const existingQuery = db
    .collection(CHART_DATA_POINTS_COLLECTION)
    .where("accountId", "==", accountId);

  let query: FirebaseFirestore.Query;
  if (companyId) {
    query = existingQuery.where("companyId", "==", companyId);
  } else {
    query = existingQuery.where("companyId", "==", null);
  }

  const existingSnap = await query.get();

  // Use batched writes (max 500 per batch)
  const batchSize = 450; // Leave room for writes
  let batch = db.batch();
  let opCount = 0;

  // Delete old data points
  for (const doc of existingSnap.docs) {
    batch.delete(doc.ref);
    opCount++;
    if (opCount >= batchSize) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  // Write new data points
  for (const dp of dataPoints) {
    const docRef = db.collection(CHART_DATA_POINTS_COLLECTION).doc(dp.id);
    const { id, ...data } = dp;
    batch.set(docRef, {
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    });
    opCount++;
    if (opCount >= batchSize) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
  }
}

// ─── recomposeAllAffected ────────────────────────────────────────────────────

/**
 * Recomposes snapshots for ALL tenants.
 * Reads all tenant-stats documents to get the list of tenants,
 * then calls compose() for each one wrapped in try/catch.
 */
export async function recomposeAllAffected(
  db: FirebaseFirestore.Firestore
): Promise<{ recomposed: number; failed: number }> {
  const tenantStatsSnap = await db.collection(TENANT_STATS_COLLECTION).get();

  let recomposed = 0;
  let failed = 0;

  for (const doc of tenantStatsSnap.docs) {
    const data = doc.data() as { accountId: string; companyId?: string | null };
    try {
      await compose(db, {
        accountId: data.accountId,
        companyId: data.companyId ?? undefined,
      });
      recomposed++;
    } catch (error) {
      console.error(
        `[snapshot-composer] Failed to recompose for tenant ${data.accountId}/${data.companyId ?? "no-company"}:`,
        error
      );
      failed++;
    }
  }

  return { recomposed, failed };
}

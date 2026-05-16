import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getMetricsFromCache, getCardsFromCache, getChartsFromCache } from "./definition-cache.js";
import { formatValue, computeRatioProgress, buildSnapshotDocId, getCurrentPeriod } from "./dashboard-utils.js";
import type { MetricDefinition, SnapshotDocument } from "./dashboard.types.js";

const SNAPSHOTS_COLLECTION = "dashboard-snapshots";
const MAX_CHART_PERIODS = 12;

// ─── toFiniteNumber ───────────────────────────────────────────────────────────

/**
 * Safely converts a value to a finite number.
 * Returns 0 for undefined, null, NaN, Infinity, -Infinity.
 * Logs a warning for non-finite values that are not undefined/null.
 */
function toFiniteNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    if (value !== undefined && value !== null) {
      console.warn(`[incremental] Non-finite value encountered: ${value}`);
    }
    return 0;
  }
  return num;
}

// ─── calculateDelta ───────────────────────────────────────────────────────────

/**
 * Calculates the numeric delta for a metric based on CRUD action and deltaType.
 *
 * - "count": create → +1, delete → -1, update → 0
 * - "sum": create → fieldValue, delete → -fieldValue, update → new - old
 * - "custom": 0 (delegated to future registered functions)
 */
function calculateDelta(
  metric: MetricDefinition,
  action: "create" | "update" | "delete",
  document?: Record<string, unknown>,
  previousDocument?: Record<string, unknown>
): number {
  const deltaType = metric.source?.deltaType ?? "count";
  const fieldName = metric.source?.fieldName;

  switch (deltaType) {
    case "count":
      return action === "create" ? 1 : action === "delete" ? -1 : 0;

    case "sum": {
      if (!fieldName) {
        console.warn(`[incremental] Metric ${metric.metricKey} has deltaType=sum but no fieldName`);
        return 0;
      }
      const currentValue = toFiniteNumber(document?.[fieldName]);
      const previousValue = toFiniteNumber(previousDocument?.[fieldName]);
      switch (action) {
        case "create":
          return currentValue;
        case "delete":
          return -previousValue || -currentValue;
        case "update":
          return currentValue - previousValue;
      }
    }

    case "custom":
      return 0;

    default:
      return 0;
  }
}

// ─── trackMetric ──────────────────────────────────────────────────────────────

/**
 * Updates the snapshot incrementally for a single metric.
 *
 * 1. Builds update payload with FieldValue.increment() for counters and history.
 * 2. If document doesn't exist, creates it with set().
 * 3. Reads the updated document to get the counter value.
 * 4. Updates cards and charts with formatted values.
 */
export async function trackMetric(
  db: FirebaseFirestore.Firestore,
  params: {
    accountId: string;
    companyId?: string;
    metricKey: string;
    delta: number;
  }
): Promise<void> {
  const { accountId, companyId, metricKey, delta } = params;

  if (!accountId) return;
  if (delta === 0) return;

  const period = getCurrentPeriod();
  const docId = buildSnapshotDocId(accountId, companyId, period);
  const docRef = db.collection(SNAPSHOTS_COLLECTION).doc(docId);

  // ── Write 1: Atomic increment ──────────────────────────────────────────
  try {
    await docRef.update({
      [`counters.${metricKey}`]: FieldValue.increment(delta),
      [`history.${metricKey}.${period}`]: FieldValue.increment(delta),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    // If document doesn't exist, create it with set()
    if (err?.code === 5 || err?.message?.includes("NOT_FOUND")) {
      await createInitialSnapshot(db, docRef, accountId, companyId ?? null, period, metricKey, delta);
      return;
    }
    throw err;
  }

  // ── Read: Get updated counters ─────────────────────────────────────────
  const snap = await docRef.get();
  if (!snap.exists) return;
  const data = snap.data() as SnapshotDocument;
  const updatedCounters = data.counters ?? {};
  const updatedHistory = data.history ?? {};

  // ── Write 2: Update cards and charts ───────────────────────────────────
  await updateCardsAndCharts(db, docRef, data, metricKey, updatedCounters, updatedHistory, period);
}

// ─── createInitialSnapshot ────────────────────────────────────────────────────

/**
 * Creates a brand new snapshot document with initial values.
 * Used when trackMetric encounters a NOT_FOUND error.
 */
async function createInitialSnapshot(
  db: FirebaseFirestore.Firestore,
  docRef: FirebaseFirestore.DocumentReference,
  accountId: string,
  companyId: string | null,
  period: string,
  triggeredMetricKey: string,
  triggeredDelta: number
): Promise<void> {
  const [metrics, cards, charts] = await Promise.all([
    getMetricsFromCache(db as any),
    getCardsFromCache(db as any),
    getChartsFromCache(db as any),
  ]);

  const counters: Record<string, number> = {};
  for (const m of metrics) {
    counters[m.metricKey] = m.metricKey === triggeredMetricKey ? triggeredDelta : 0;
  }

  const history: Record<string, Record<string, number>> = {};
  for (const m of metrics) {
    history[m.metricKey] = { [period]: counters[m.metricKey] };
  }

  const cardsMap: Record<string, any> = {};
  for (const card of cards) {
    if (!card.active || card.metricKey !== triggeredMetricKey) continue;
    const rawValue = counters[card.metricKey] ?? 0;
    const metric = metrics.find((m) => m.metricKey === card.metricKey);
    const valueFormat = metric?.valueFormat ?? "number";
    cardsMap[card.cardKey] = buildCardEntry(card, metric ?? null, rawValue, counters);
  }

  const chartsMap: Record<string, any> = {};
  for (const chart of charts) {
    if (!chart.active) continue;
    chartsMap[chart.chartKey] = buildChartEntry(chart, counters, history, period);
  }

  const snapshot: Omit<SnapshotDocument, "updatedAt"> = {
    accountId,
    companyId,
    period,
    counters,
    cards: cardsMap,
    charts: chartsMap,
    history,
    activityItems: [],
    metadata: { generatedAt: FieldValue.serverTimestamp() as any, configSource: "incremental" },
  };

  await docRef.set(snapshot);
}

// ─── updateCardsAndCharts ─────────────────────────────────────────────────────

/**
 * Updates cards and charts maps after a counter increment.
 */
async function updateCardsAndCharts(
  db: FirebaseFirestore.Firestore,
  docRef: FirebaseFirestore.DocumentReference,
  data: SnapshotDocument,
  metricKey: string,
  counters: Record<string, number>,
  history: Record<string, Record<string, number>>,
  period: string
): Promise<void> {
  const payload: Record<string, unknown> = {
    "metadata.generatedAt": FieldValue.serverTimestamp(),
    "metadata.configSource": "incremental",
    updatedAt: FieldValue.serverTimestamp(),
  };

  const [metrics, cards, charts] = await Promise.all([
    getMetricsFromCache(db as any),
    getCardsFromCache(db as any),
    getChartsFromCache(db as any),
  ]);

  // Update cards that reference this metricKey
  for (const card of cards) {
    if (!card.active || card.metricKey !== metricKey) continue;
    const rawValue = counters[metricKey] ?? 0;
    const metric = metrics.find((m) => m.metricKey === card.metricKey);
    const valueFormat = metric?.valueFormat ?? "number";

    const entry = buildCardEntry(card, metric ?? null, rawValue, counters);
    payload[`cards.${card.cardKey}`] = entry;
  }

  // Update charts that reference this metricKey
  for (const chart of charts) {
    if (!chart.active) continue;
    if (!chart.metricKeys.includes(metricKey)) continue;

    const existingChart = data.charts?.[chart.chartKey];
    const chartEntry = buildChartEntry(chart, counters, history, period, existingChart);
    payload[`charts.${chart.chartKey}`] = chartEntry;
  }

  // Enforce max 12 periods in history
  const metricHistory = history[metricKey] ?? {};
  const periods = Object.keys(metricHistory).sort();
  if (periods.length > MAX_CHART_PERIODS) {
    const oldest = periods[0];
    payload[`history.${metricKey}.${oldest}`] = FieldValue.delete();
  }

  await docRef.update(payload);
}

// ─── buildCardEntry ───────────────────────────────────────────────────────────

function buildCardEntry(
  card: any,
  metric: any | null,
  rawValue: number,
  counters: Record<string, number>
): Record<string, unknown> {
  const valueFormat = metric?.valueFormat ?? "number";
  let progressPct: number | null = null;
  let progressLabel: string | null = null;

  if (metric?.type === "ratio" && metric.numeratorMetricKey && metric.denominatorMetricKey) {
    const numerator = counters[metric.numeratorMetricKey] ?? 0;
    const denominator = counters[metric.denominatorMetricKey] ?? 0;
    progressPct = computeRatioProgress(numerator, denominator);
    progressLabel = `${numerator} / ${denominator}`;
  }

  return {
    cardKey: card.cardKey,
    metricKey: card.metricKey,
    title: card.title,
    subtitle: null,
    icon: card.icon,
    accentClass: card.accentClass,
    value: formatValue(rawValue, valueFormat as any),
    rawValue,
    progressPct,
    progressLabel,
    href: null,
    permissionModule: card.permissionModule ?? null,
    target: card.target,
    order: card.order ?? 0,
  };
}

// ─── buildChartEntry ──────────────────────────────────────────────────────────

function buildChartEntry(
  chart: any,
  counters: Record<string, number>,
  history: Record<string, Record<string, number>>,
  period: string,
  existingChart?: any
): Record<string, unknown> {
  const chartType = chart.chartType;
  const metricKeys = chart.metricKeys;

  let labels: string[] = [];
  const datasets: Array<{ metricKey: string; label: string; data: number[] }> = [];

  if (chartType === "line" || chartType === "bar") {
    // Collect all periods from history for the chart's metrics
    const periodsSet = new Set<string>();
    for (const mk of metricKeys) {
      const mh = history[mk] ?? {};
      for (const p of Object.keys(mh)) {
        periodsSet.add(p);
      }
    }
    labels = Array.from(periodsSet).sort().slice(-MAX_CHART_PERIODS);

    for (const mk of metricKeys) {
      const mh = history[mk] ?? {};
      const data = labels.map((p) => mh[p] ?? 0);
      const metricLabel = mk; // Will be resolved in compose
      datasets.push({ metricKey: mk, label: metricLabel, data });
    }
  } else {
    // Pie/doughnut: current period values
    labels = metricKeys.map((mk: string) => {
      const mh = history[mk] ?? {};
      return mk;
    });
    const data = metricKeys.map((mk: string) => counters[mk] ?? 0);
    datasets.push({ metricKey: metricKeys.join(","), label: chart.title ?? "", data });
  }

  return {
    chartKey: chart.chartKey,
    title: chart.title,
    chartType,
    permissionModule: chart.permissionModule ?? null,
    target: chart.target,
    labels,
    datasets,
  };
}

// ─── trackEntityChange ────────────────────────────────────────────────────────

/**
 * Derives metricKey(s) and delta(s) from a CRUD operation on a collection,
 * and invokes trackMetric() for each derived metric.
 *
 * Recommended integration point for backend routers.
 *
 * @example
 * ```typescript
 * // In sales.router.ts — POST /sale-orders
 * const created = await db.collection("sale-orders").doc(docId).set(data);
 * trackEntityChange(db, {
 *   accountId,
 *   companyId,
 *   collectionName: "sale-orders",
 *   action: "create",
 *   document: data,
 * }).catch(err => console.error("[sale-orders] trackEntityChange failed:", err));
 * return res.status(201).json({ id: docId });
 * ```
 */
export async function trackEntityChange(
  db: FirebaseFirestore.Firestore,
  params: {
    accountId: string;
    companyId?: string;
    collectionName: string;
    action: "create" | "update" | "delete";
    document?: Record<string, unknown>;
    previousDocument?: Record<string, unknown>;
  }
): Promise<void> {
  const { accountId, companyId, collectionName, action, document, previousDocument } = params;

  if (!accountId) return;

  // Resolve all metrics from cache that match this collection
  const metrics = await getMetricsFromCache(db as any);
  const matchingMetrics = metrics.filter(
    (m) => m.active && m.source?.collectionName === collectionName
  );

  if (matchingMetrics.length === 0) return;

  await Promise.all(
    matchingMetrics.map((metric) => {
      const delta = calculateDelta(metric, action, document, previousDocument);
      if (delta === 0) return Promise.resolve();
      return trackMetric(db, { accountId, companyId, metricKey: metric.metricKey, delta });
    })
  );
}

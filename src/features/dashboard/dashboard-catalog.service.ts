import type { firestore as FirebaseFirestore } from "firebase-admin";
import { getDefaultMetricDefinitions } from "../../data/default-metric-definitions.js";
import { getDefaultCardDefinitions } from "../../data/default-card-definitions.js";
import { getDefaultChartDefinitions } from "../../data/default-chart-definitions.js";
import type {
  MetricDefinition,
  CardDefinition,
  ChartDefinition,
  MergedDefinition,
} from "./dashboard.types.js";

/**
 * Checks if an ID belongs to a default catalog definition.
 * Default IDs follow the pattern "default__<key>".
 */
export function isDefaultId(id: string): boolean {
  return String(id ?? "").startsWith("default__");
}

/**
 * Lista métricas mergeadas: defaults + customs de Firestore.
 * Si un custom tiene el mismo metricKey que un default, el custom prevalece.
 */
export async function listMergedMetrics(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<MetricDefinition>[]> {
  const customSnap = await db.collection("metric-definitions").get();
  const customs = customSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as MetricDefinition[];
  const customByKey = new Map(customs.map(c => [c.metricKey, c]));

  const merged: MergedDefinition<MetricDefinition>[] = [];

  // Defaults first — replaced by custom if exists
  for (const def of getDefaultMetricDefinitions()) {
    const custom = customByKey.get(def.metricKey);
    if (custom) {
      merged.push({ data: custom, source: "custom", readonly: false });
      customByKey.delete(def.metricKey);
    } else {
      merged.push({ data: def as unknown as MetricDefinition, source: "default", readonly: true });
    }
  }

  // Remaining customs (no matching default)
  for (const [, custom] of customByKey) {
    merged.push({ data: custom, source: "custom", readonly: false });
  }

  return merged;
}

/**
 * Lista cards mergeadas: defaults + customs de Firestore.
 * Si un custom tiene el mismo cardKey que un default, el custom prevalece.
 */
export async function listMergedCards(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<CardDefinition>[]> {
  const customSnap = await db.collection("dashboard-card-definitions").get();
  const customs = customSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as CardDefinition[];
  const customByKey = new Map(customs.map(c => [c.cardKey, c]));

  const merged: MergedDefinition<CardDefinition>[] = [];

  for (const def of getDefaultCardDefinitions()) {
    const custom = customByKey.get(def.cardKey);
    if (custom) {
      merged.push({ data: custom, source: "custom", readonly: false });
      customByKey.delete(def.cardKey);
    } else {
      merged.push({ data: def as unknown as CardDefinition, source: "default", readonly: true });
    }
  }

  for (const [, custom] of customByKey) {
    merged.push({ data: custom, source: "custom", readonly: false });
  }

  return merged;
}

/**
 * Lista charts mergeadas: defaults + customs de Firestore.
 * Si un custom tiene el mismo chartKey que un default, el custom prevalece.
 */
export async function listMergedCharts(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<ChartDefinition>[]> {
  const customSnap = await db.collection("chart-definitions").get();
  const customs = customSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as ChartDefinition[];
  const customByKey = new Map(customs.map(c => [c.chartKey, c]));

  const merged: MergedDefinition<ChartDefinition>[] = [];

  for (const def of getDefaultChartDefinitions()) {
    const custom = customByKey.get(def.chartKey);
    if (custom) {
      merged.push({ data: custom, source: "custom", readonly: false });
      customByKey.delete(def.chartKey);
    } else {
      merged.push({ data: def as unknown as ChartDefinition, source: "default", readonly: true });
    }
  }

  for (const [, custom] of customByKey) {
    merged.push({ data: custom, source: "custom", readonly: false });
  }

  return merged;
}

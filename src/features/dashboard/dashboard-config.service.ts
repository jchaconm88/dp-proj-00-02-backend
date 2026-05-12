import type { firestore as FirebaseFirestore } from "firebase-admin";
import {
  listMergedMetrics,
  listMergedCards,
  listMergedCharts,
  isDefaultId,
} from "./dashboard-catalog.service.js";
import {
  validateMetric,
  validateCard,
  validateChart,
  canDeleteMetric,
  type CreateMetricPayload,
  type CreateCardPayload,
  type CreateChartPayload,
} from "./dashboard-config-validator.js";
import { recomposeAllAffected } from "./snapshot-composer.service.js";
import type {
  MetricDefinition,
  CardDefinition,
  ChartDefinition,
  MergedDefinition,
} from "./dashboard.types.js";

// ─── Recompose Trigger (fire-and-forget) ─────────────────────────────────────

function triggerRecompose(db: FirebaseFirestore.Firestore): void {
  recomposeAllAffected(db).catch((err) => {
    console.error("[dashboard-config] triggerRecompose failed:", err);
  });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export async function listMetrics(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<MetricDefinition>[]> {
  return listMergedMetrics(db);
}

export async function createMetric(
  db: FirebaseFirestore.Firestore,
  payload: CreateMetricPayload
): Promise<{ id: string }> {
  const merged = await listMergedMetrics(db);
  const existingKeys = merged.map((m) => m.data.metricKey);

  const result = validateMetric(payload, existingKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const now = new Date();
  const doc: Record<string, unknown> = {
    metricKey: payload.metricKey,
    label: payload.label,
    type: payload.type,
    measureType: payload.measureType,
    valueFormat: payload.valueFormat,
    source: { collectionName: payload.source!.collectionName },
    active: payload.active,
    target: payload.target,
    createdAt: now,
    updatedAt: now,
  };

  if (payload.numeratorMetricKey) {
    doc.numeratorMetricKey = payload.numeratorMetricKey;
  }
  if (payload.denominatorMetricKey) {
    doc.denominatorMetricKey = payload.denominatorMetricKey;
  }
  if (payload.permissionModule !== undefined) {
    doc.permissionModule = payload.permissionModule ?? null;
  }

  const created = await db.collection("metric-definitions").add(doc);
  triggerRecompose(db);
  return { id: created.id };
}

export async function updateMetric(
  db: FirebaseFirestore.Firestore,
  id: string,
  payload: Partial<CreateMetricPayload>
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede modificar un item de solo lectura (default)");
  }

  const docRef = db.collection("metric-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Metric not found");
  }

  const current = snap.data() as MetricDefinition;

  // Build the updated payload for validation (merge current + patch)
  const merged = await listMergedMetrics(db);
  // Exclude current key from uniqueness check (it's the same doc)
  const existingKeys = merged
    .map((m) => m.data.metricKey)
    .filter((k) => k !== current.metricKey);

  const validationPayload: CreateMetricPayload = {
    metricKey: current.metricKey, // metricKey is immutable
    label: payload.label ?? current.label,
    type: payload.type ?? current.type,
    measureType: payload.measureType ?? current.measureType,
    valueFormat: payload.valueFormat ?? current.valueFormat,
    source: payload.source ?? current.source,
    active: payload.active ?? current.active,
    target: payload.target ?? current.target ?? "both",
    numeratorMetricKey: payload.numeratorMetricKey ?? current.numeratorMetricKey,
    denominatorMetricKey: payload.denominatorMetricKey ?? current.denominatorMetricKey,
  };

  const result = validateMetric(validationPayload, existingKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  // metricKey is immutable — do not allow changes
  if (payload.label !== undefined) patch.label = payload.label;
  if (payload.type !== undefined) patch.type = payload.type;
  if (payload.measureType !== undefined) patch.measureType = payload.measureType;
  if (payload.valueFormat !== undefined) patch.valueFormat = payload.valueFormat;
  if (payload.source !== undefined) patch.source = payload.source;
  if (payload.active !== undefined) patch.active = payload.active;
  if (payload.target !== undefined) patch.target = payload.target;
  if (payload.numeratorMetricKey !== undefined) patch.numeratorMetricKey = payload.numeratorMetricKey;
  if (payload.denominatorMetricKey !== undefined) patch.denominatorMetricKey = payload.denominatorMetricKey;
  if (payload.permissionModule !== undefined) patch.permissionModule = payload.permissionModule ?? null;

  await docRef.update(patch);
  triggerRecompose(db);
}

export async function deleteMetric(
  db: FirebaseFirestore.Firestore,
  id: string
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede eliminar un item de solo lectura (default)");
  }

  const docRef = db.collection("metric-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Metric not found");
  }

  const metric = { id: snap.id, ...snap.data() } as MetricDefinition;

  // Check referential integrity: cards and charts referencing this metric
  const mergedCards = await listMergedCards(db);
  const mergedCharts = await listMergedCharts(db);

  const cards = mergedCards.map((m) => m.data);
  const charts = mergedCharts.map((m) => m.data);

  const deletionCheck = canDeleteMetric(metric.metricKey, cards, charts);
  if (!deletionCheck.canDelete) {
    throw new Error(
      `No se puede eliminar la métrica: está referenciada por ${deletionCheck.referencedBy.join(", ")}`
    );
  }

  await docRef.delete();
  triggerRecompose(db);
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export async function listCards(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<CardDefinition>[]> {
  return listMergedCards(db);
}

export async function createCard(
  db: FirebaseFirestore.Firestore,
  payload: CreateCardPayload
): Promise<{ id: string }> {
  const mergedCards = await listMergedCards(db);
  const mergedMetrics = await listMergedMetrics(db);

  const existingCardKeys = mergedCards.map((c) => c.data.cardKey);
  const existingMetricKeys = mergedMetrics.map((m) => m.data.metricKey);

  const result = validateCard(payload, existingCardKeys, existingMetricKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const now = new Date();
  const doc: Record<string, unknown> = {
    cardKey: payload.cardKey,
    metricKey: payload.metricKey,
    title: payload.title,
    icon: payload.icon,
    accentClass: payload.accentClass,
    order: payload.order,
    visible: payload.visible,
    active: payload.active,
    target: payload.target,
    createdAt: now,
    updatedAt: now,
  };

  if (payload.permissionModule !== undefined) {
    doc.permissionModule = payload.permissionModule ?? null;
  }

  const created = await db.collection("dashboard-card-definitions").add(doc);
  triggerRecompose(db);
  return { id: created.id };
}

export async function updateCard(
  db: FirebaseFirestore.Firestore,
  id: string,
  payload: Partial<CreateCardPayload>
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede modificar un item de solo lectura (default)");
  }

  const docRef = db.collection("dashboard-card-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Card not found");
  }

  const current = snap.data() as CardDefinition;

  // Build validation payload (merge current + patch)
  const mergedCards = await listMergedCards(db);
  const mergedMetrics = await listMergedMetrics(db);

  // Exclude current key from uniqueness check
  const existingCardKeys = mergedCards
    .map((c) => c.data.cardKey)
    .filter((k) => k !== current.cardKey);
  const existingMetricKeys = mergedMetrics.map((m) => m.data.metricKey);

  const validationPayload: CreateCardPayload = {
    cardKey: current.cardKey, // cardKey is immutable
    metricKey: payload.metricKey ?? current.metricKey,
    title: payload.title ?? current.title,
    icon: payload.icon ?? current.icon,
    accentClass: payload.accentClass ?? current.accentClass,
    order: payload.order ?? current.order,
    visible: payload.visible ?? current.visible,
    active: payload.active ?? current.active,
    target: payload.target ?? current.target,
  };

  const result = validateCard(validationPayload, existingCardKeys, existingMetricKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  // cardKey is immutable — do not allow changes
  if (payload.metricKey !== undefined) patch.metricKey = payload.metricKey;
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.icon !== undefined) patch.icon = payload.icon;
  if (payload.accentClass !== undefined) patch.accentClass = payload.accentClass;
  if (payload.order !== undefined) patch.order = payload.order;
  if (payload.visible !== undefined) patch.visible = payload.visible;
  if (payload.active !== undefined) patch.active = payload.active;
  if (payload.target !== undefined) patch.target = payload.target;
  if (payload.permissionModule !== undefined) patch.permissionModule = payload.permissionModule ?? null;

  await docRef.update(patch);
  triggerRecompose(db);
}

export async function deleteCard(
  db: FirebaseFirestore.Firestore,
  id: string
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede eliminar un item de solo lectura (default)");
  }

  const docRef = db.collection("dashboard-card-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Card not found");
  }

  await docRef.delete();
  triggerRecompose(db);
}

// ─── Charts ──────────────────────────────────────────────────────────────────

export async function listCharts(
  db: FirebaseFirestore.Firestore
): Promise<MergedDefinition<ChartDefinition>[]> {
  return listMergedCharts(db);
}

export async function createChart(
  db: FirebaseFirestore.Firestore,
  payload: CreateChartPayload
): Promise<{ id: string }> {
  const mergedCharts = await listMergedCharts(db);
  const mergedMetrics = await listMergedMetrics(db);

  const existingChartKeys = mergedCharts.map((c) => c.data.chartKey);
  const existingMetricKeys = mergedMetrics.map((m) => m.data.metricKey);

  const result = validateChart(payload, existingChartKeys, existingMetricKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const now = new Date();
  const doc: Record<string, unknown> = {
    chartKey: payload.chartKey,
    title: payload.title,
    chartType: payload.chartType,
    metricKeys: payload.metricKeys,
    groupBy: payload.groupBy,
    target: payload.target,
    permissionModule: payload.permissionModule,
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  const created = await db.collection("chart-definitions").add(doc);
  triggerRecompose(db);
  return { id: created.id };
}

export async function updateChart(
  db: FirebaseFirestore.Firestore,
  id: string,
  payload: Partial<CreateChartPayload>
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede modificar un item de solo lectura (default)");
  }

  const docRef = db.collection("chart-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Chart not found");
  }

  const current = snap.data() as ChartDefinition;

  // Build validation payload (merge current + patch)
  const mergedCharts = await listMergedCharts(db);
  const mergedMetrics = await listMergedMetrics(db);

  // Exclude current key from uniqueness check
  const existingChartKeys = mergedCharts
    .map((c) => c.data.chartKey)
    .filter((k) => k !== current.chartKey);
  const existingMetricKeys = mergedMetrics.map((m) => m.data.metricKey);

  const validationPayload: CreateChartPayload = {
    chartKey: current.chartKey, // chartKey is immutable
    title: payload.title ?? current.title,
    chartType: payload.chartType ?? current.chartType,
    metricKeys: payload.metricKeys ?? current.metricKeys,
    groupBy: payload.groupBy ?? current.groupBy,
    target: payload.target ?? current.target,
    permissionModule: payload.permissionModule ?? current.permissionModule,
  };

  const result = validateChart(validationPayload, existingChartKeys, existingMetricKeys);
  if (!result.valid) {
    throw new Error(
      `Validation failed: ${result.errors.map((e) => e.message).join("; ")}`
    );
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  // chartKey is immutable — do not allow changes
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.chartType !== undefined) patch.chartType = payload.chartType;
  if (payload.metricKeys !== undefined) patch.metricKeys = payload.metricKeys;
  if (payload.groupBy !== undefined) patch.groupBy = payload.groupBy;
  if (payload.target !== undefined) patch.target = payload.target;
  if (payload.permissionModule !== undefined) patch.permissionModule = payload.permissionModule;

  await docRef.update(patch);
  triggerRecompose(db);
}

export async function deleteChart(
  db: FirebaseFirestore.Firestore,
  id: string
): Promise<void> {
  if (isDefaultId(id)) {
    throw new Error("No se puede eliminar un item de solo lectura (default)");
  }

  const docRef = db.collection("chart-definitions").doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error("Chart not found");
  }

  await docRef.delete();
  triggerRecompose(db);
}

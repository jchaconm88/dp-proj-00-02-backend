import type { firestore } from "firebase-admin";

type Timestamp = firestore.Timestamp;

// ─── Metric Definitions (metric-definitions collection) ─────────────────────

export type DeltaType = "count" | "sum" | "custom";
export type ValueFormat = "number" | "currency" | "percentage" | "bytes";

export interface MetricDefinition {
  id: string;
  metricKey: string;
  label: string;
  type: "entityCount" | "sum" | "ratio" | "custom";
  measureType: "counterMonthly" | "gaugeCurrent";
  valueFormat: ValueFormat;
  source: {
    collectionName: string;
    fieldName?: string;
    deltaType?: DeltaType;
  };
  numeratorMetricKey?: string;
  denominatorMetricKey?: string;
  permissionModule?: string | null;
  active: boolean;
  target?: "admin" | "web" | "both";
  readonly?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Card Definitions (dashboard-card-definitions collection) ────────────────

export interface CardDefinition {
  id: string;
  cardKey: string;
  metricKey: string;
  title: string;
  icon: string;
  accentClass: string;
  order: number;
  visible: boolean;
  active: boolean;
  target: "admin" | "web" | "both";
  permissionModule?: string | null;
  readonly?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Chart Definitions (chart-definitions collection) ────────────────────────

export interface ChartDefinition {
  id: string;
  chartKey: string;
  title: string;
  chartType: "bar" | "line" | "pie" | "doughnut";
  metricKeys: string[];
  groupBy: "daily" | "weekly" | "monthly";
  target: "admin" | "web" | "both";
  permissionModule: string;
  active: boolean;
  readonly?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─── Dashboard Snapshot (dashboard-snapshots collection) ─────────────────────

export interface DashboardSnapshot {
  id: string;
  accountId: string;
  companyId: string | null;
  period: string;
  cards: SnapshotCard[];
  charts: SnapshotChart[];
  activityItems: ActivityItem[];
  metadata: {
    generatedAt: Timestamp;
    configSource: string;
  };
  updatedAt: Timestamp;
}

// ─── Snapshot Card (embedded in DashboardSnapshot.cards) ─────────────────────

export interface SnapshotCard {
  id: string;
  cardKey: string;
  metricKey: string;
  title: string;
  subtitle: string | null;
  icon: string;
  accentClass: string;
  value: string;
  rawValue: number;
  progressPct: number | null;
  progressLabel: string | null;
  href: string | null;
  permissionModule: string | null;
  target: "admin" | "web" | "both";
}

// ─── Snapshot Chart (embedded in DashboardSnapshot.charts) ───────────────────

export interface SnapshotChart {
  id: string;
  chartKey: string;
  title: string;
  chartType: "bar" | "line" | "pie" | "doughnut";
  permissionModule: string | null;
  target: "admin" | "web" | "both";
  labels: string[];
  datasets: Array<{
    metricKey: string;
    label: string;
    data: number[];
  }>;
}

// ─── Activity Item (embedded in DashboardSnapshot.activityItems) ─────────────

export interface ActivityItem {
  id: string;
  type: string;
  description: string;
  timestamp: string;
  entityRef: string | null;
  userId: string;
}

// ─── Tenant Stats (tenant-stats collection) ──────────────────────────────────

export interface TenantStats {
  id: string;
  accountId: string;
  companyId: string | null;
  counters: Record<string, number>;
  updatedAt: Timestamp;
}

// ─── Chart Data Points (chart-data-points collection) ────────────────────────

export interface ChartDataPoint {
  id: string;
  accountId: string;
  companyId: string | null;
  metricKey: string;
  period: string;
  value: number;
  createdAt: Timestamp;
}

// ─── Snapshot Document (nuevo formato unificado) ──────────────────────────────

export interface SnapshotDocument {
  accountId: string;
  companyId: string | null;
  period: string;
  counters: Record<string, number>;
  cards: Record<string, SnapshotCardEntry>;
  charts: Record<string, SnapshotChartEntry>;
  history: Record<string, Record<string, number>>;
  activityItems: ActivityItem[];
  metadata: {
    generatedAt: Timestamp;
    configSource: "incremental" | "compose";
  };
  updatedAt: Timestamp;
}

export interface SnapshotCardEntry {
  cardKey: string;
  metricKey: string;
  title: string;
  subtitle: string | null;
  icon: string;
  accentClass: string;
  value: string;
  rawValue: number;
  progressPct: number | null;
  progressLabel: string | null;
  href: string | null;
  permissionModule: string | null;
  target: "admin" | "web" | "both";
  order: number;
}

export interface SnapshotChartEntry {
  chartKey: string;
  title: string;
  chartType: "bar" | "line" | "pie" | "doughnut";
  permissionModule: string | null;
  target: "admin" | "web" | "both";
  labels: string[];
  datasets: Array<{
    metricKey: string;
    label: string;
    data: number[];
  }>;
}

// ─── Dashboard Snapshot Response (API output) ─────────────────────────────────

export interface DashboardSnapshotResponse {
  accountId: string;
  companyId: string | null;
  period: string;
  cards: SnapshotCardEntry[];
  charts: SnapshotChartEntry[];
  counters: Record<string, number>;
  activityItems: ActivityItem[];
  metadata: {
    generatedAt: Timestamp;
    configSource: string;
  } | null;
}

// ─── Cache Entry (definition-cache.ts) ────────────────────────────────────────

export interface CacheEntry<T> {
  data: T[];
  loadedAt: number;
  inflight: Promise<T[]> | null;
}

// ─── Company Dashboard Overrides (company-dashboard-overrides collection) ────

export interface CompanyDashboardOverride {
  id: string;
  entries: Array<{
    definitionId: string;
    definitionType: "card" | "chart";
    visible: boolean;
    order: number;
  }>;
  updatedAt: Timestamp;
}

// ─── Merged Definition (used by catalog merge service) ───────────────────────

export type DefinitionSource = "default" | "custom";

export interface MergedDefinition<T> {
  data: T;
  source: DefinitionSource;
  readonly: boolean;
}

// ─── Validation Result (used by dashboard-config-validator) ──────────────────

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

// ─── Deletion Check (used by dashboard-config-validator) ─────────────────────

export type DeletionCheck =
  | { canDelete: true }
  | { canDelete: false; referencedBy: string[] };

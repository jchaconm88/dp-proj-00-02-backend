export interface DefaultMetricDefinition {
  id: string;
  metricKey: string;
  label: string;
  type: "entityCount" | "sum" | "ratio" | "custom";
  measureType: "counterMonthly" | "gaugeCurrent";
  valueFormat: "number" | "currency" | "percentage" | "bytes";
  source: { collectionName: string; fieldName?: string; deltaType?: string };
  numeratorMetricKey?: string;
  denominatorMetricKey?: string;
  permissionModule?: string | null;
  active: boolean;
  target: "admin" | "web" | "both";
  readonly: true;
  source_type: "default";
}

export interface DefaultCardDefinition {
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
  readonly: true;
  source_type: "default";
}

export interface DefaultChartDefinition {
  id: string;
  chartKey: string;
  title: string;
  chartType: "bar" | "line" | "pie" | "doughnut";
  metricKeys: string[];
  groupBy: "daily" | "weekly" | "monthly";
  target: "admin" | "web" | "both";
  permissionModule: string;
  active: boolean;
  readonly: true;
  source_type: "default";
}

export function cloneDefault<T>(item: T): T {
  return { ...item };
}

import type { DefaultChartDefinition } from "./dashboard-catalog-types.js";
import { cloneDefault } from "./dashboard-catalog-types.js";

export const DEFAULT_CHART_DEFINITIONS: DefaultChartDefinition[] = [
  { id: "default__trips-trend", chartKey: "trips-trend", title: "Tendencia de Viajes", chartType: "line", metricKeys: ["trips-count"], groupBy: "monthly", target: "web", permissionModule: "trip", active: true, readonly: true, source_type: "default" },
  { id: "default__invoices-trend", chartKey: "invoices-trend", title: "Tendencia de Facturas", chartType: "bar", metricKeys: ["invoices-count"], groupBy: "monthly", target: "web", permissionModule: "invoice", active: true, readonly: true, source_type: "default" },
  { id: "default__trips-status-pie", chartKey: "trips-status-pie", title: "Viajes por Estado", chartType: "pie", metricKeys: ["trips-by-status"], groupBy: "monthly", target: "web", permissionModule: "trip", active: true, readonly: true, source_type: "default" },
  { id: "default__invoices-status-doughnut", chartKey: "invoices-status-doughnut", title: "Facturas por Estado", chartType: "doughnut", metricKeys: ["invoices-by-status"], groupBy: "monthly", target: "web", permissionModule: "invoice", active: true, readonly: true, source_type: "default" },
  { id: "default__usage-overview", chartKey: "usage-overview", title: "Uso de Plataforma", chartType: "bar", metricKeys: ["report-runs", "emails-sent"], groupBy: "monthly", target: "admin", permissionModule: "report", active: true, readonly: true, source_type: "default" },
];

export function getDefaultChartDefinitions(): DefaultChartDefinition[] {
  return DEFAULT_CHART_DEFINITIONS.map(cloneDefault);
}

export function getDefaultChartByKey(chartKey: string): DefaultChartDefinition | null {
  const row = DEFAULT_CHART_DEFINITIONS.find(c => c.chartKey === chartKey);
  return row ? cloneDefault(row) : null;
}

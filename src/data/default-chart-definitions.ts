import type { DefaultChartDefinition } from "./dashboard-catalog-types.js";
import { cloneDefault } from "./dashboard-catalog-types.js";

export const DEFAULT_CHART_DEFINITIONS: DefaultChartDefinition[] = [
  { id: "default__trips-trend", chartKey: "trips-trend", title: "Tendencia de Viajes", chartType: "line", metricKeys: ["trips-count"], groupBy: "monthly", target: "web", permissionModule: "trip", active: true, readonly: true, source_type: "default" },
  { id: "default__invoices-trend", chartKey: "invoices-trend", title: "Tendencia de Facturas", chartType: "bar", metricKeys: ["invoices-count"], groupBy: "monthly", target: "web", permissionModule: "invoice", active: true, readonly: true, source_type: "default" },
  { id: "default__trips-status-pie", chartKey: "trips-status-pie", title: "Viajes por Estado", chartType: "pie", metricKeys: ["trips-by-status"], groupBy: "monthly", target: "web", permissionModule: "trip", active: true, readonly: true, source_type: "default" },
  { id: "default__invoices-status-doughnut", chartKey: "invoices-status-doughnut", title: "Facturas por Estado", chartType: "doughnut", metricKeys: ["invoices-by-status"], groupBy: "monthly", target: "web", permissionModule: "invoice", active: true, readonly: true, source_type: "default" },
  { id: "default__purchase-orders-trend", chartKey: "purchase-orders-trend", title: "Tendencia órdenes de compra", chartType: "bar", metricKeys: ["purchase-orders-count"], groupBy: "monthly", target: "web", permissionModule: "purchase-order", active: true, readonly: true, source_type: "default" },
  { id: "default__sale-orders-trend", chartKey: "sale-orders-trend", title: "Tendencia órdenes de venta", chartType: "bar", metricKeys: ["sale-orders-count"], groupBy: "monthly", target: "web", permissionModule: "sale-order", active: true, readonly: true, source_type: "default" },
  { id: "default__inventory-movements-trend", chartKey: "inventory-movements-trend", title: "Movimientos de inventario", chartType: "line", metricKeys: ["inventory-movements-count"], groupBy: "monthly", target: "web", permissionModule: "inventory-movement", active: true, readonly: true, source_type: "default" },
  { id: "default__usage-overview", chartKey: "usage-overview", title: "Uso de Plataforma", chartType: "bar", metricKeys: ["report-runs", "emails-sent"], groupBy: "monthly", target: "admin", permissionModule: "report", active: true, readonly: true, source_type: "default" },
];

export function getDefaultChartDefinitions(): DefaultChartDefinition[] {
  return DEFAULT_CHART_DEFINITIONS.map(cloneDefault);
}

export function getDefaultChartByKey(chartKey: string): DefaultChartDefinition | null {
  const row = DEFAULT_CHART_DEFINITIONS.find(c => c.chartKey === chartKey);
  return row ? cloneDefault(row) : null;
}

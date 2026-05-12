import type { DefaultMetricDefinition } from "./dashboard-catalog-types.js";
import { cloneDefault } from "./dashboard-catalog-types.js";

export const DEFAULT_METRIC_DEFINITIONS: DefaultMetricDefinition[] = [
  // Entity counts (web)
  { id: "default__trips-count", metricKey: "trips-count", label: "Total Viajes", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "trips" }, permissionModule: "trip", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__settlements-count", metricKey: "settlements-count", label: "Total Liquidaciones", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "settlements" }, permissionModule: "settlement", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__invoices-count", metricKey: "invoices-count", label: "Total Facturas", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "invoices" }, permissionModule: "invoice", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__clients-count", metricKey: "clients-count", label: "Total Clientes", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "clients" }, permissionModule: "client", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__employees-count", metricKey: "employees-count", label: "Total Empleados", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "employees" }, permissionModule: "employee", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__vehicles-count", metricKey: "vehicles-count", label: "Total Vehículos", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "vehicles" }, permissionModule: "vehicle", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__drivers-count", metricKey: "drivers-count", label: "Total Operadores", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "drivers" }, permissionModule: "driver", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__orders-count", metricKey: "orders-count", label: "Total Órdenes", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "orders" }, permissionModule: "order", active: true, target: "web", readonly: true, source_type: "default" },
  // Usage metrics (admin)
  { id: "default__report-runs", metricKey: "report-runs", label: "Reportes Ejecutados", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "report-runs" }, permissionModule: "report", active: true, target: "admin", readonly: true, source_type: "default" },
  { id: "default__emails-sent", metricKey: "emails-sent", label: "Correos Enviados", type: "sum", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "email-log" }, permissionModule: "report", active: true, target: "admin", readonly: true, source_type: "default" },
  { id: "default__storage-bytes-used", metricKey: "storage-bytes-used", label: "Almacenamiento Usado", type: "sum", measureType: "gaugeCurrent", valueFormat: "bytes", source: { collectionName: "storage-usage" }, permissionModule: null, active: true, target: "admin", readonly: true, source_type: "default" },
  // Ratio metrics (web)
  { id: "default__trips-completed-vs-pending", metricKey: "trips-completed-vs-pending", label: "Viajes Completados vs Pendientes", type: "ratio", measureType: "gaugeCurrent", valueFormat: "percentage", source: { collectionName: "trips" }, numeratorMetricKey: "trips-completed", denominatorMetricKey: "trips-count", permissionModule: "trip", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__invoices-paid-vs-pending", metricKey: "invoices-paid-vs-pending", label: "Facturas Pagadas vs Pendientes", type: "ratio", measureType: "gaugeCurrent", valueFormat: "percentage", source: { collectionName: "invoices" }, numeratorMetricKey: "invoices-paid", denominatorMetricKey: "invoices-count", permissionModule: "invoice", active: true, target: "web", readonly: true, source_type: "default" },
  // Status breakdown (web)
  { id: "default__trips-by-status", metricKey: "trips-by-status", label: "Viajes por Estado", type: "custom", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "trips" }, permissionModule: "trip", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__invoices-by-status", metricKey: "invoices-by-status", label: "Facturas por Estado", type: "custom", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "invoices" }, permissionModule: "invoice", active: true, target: "web", readonly: true, source_type: "default" },
];

export function getDefaultMetricDefinitions(): DefaultMetricDefinition[] {
  return DEFAULT_METRIC_DEFINITIONS.map(cloneDefault);
}

export function getDefaultMetricByKey(metricKey: string): DefaultMetricDefinition | null {
  const row = DEFAULT_METRIC_DEFINITIONS.find(m => m.metricKey === metricKey);
  return row ? cloneDefault(row) : null;
}

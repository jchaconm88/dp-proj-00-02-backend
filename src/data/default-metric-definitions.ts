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
  // Purchasing metrics (web)
  { id: "default__purchase-orders-count", metricKey: "purchase-orders-count", label: "Total Órdenes de Compra", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "purchase-orders" }, permissionModule: "purchase-order", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__purchase-orders-total", metricKey: "purchase-orders-total", label: "Monto Total Compras", type: "sum", measureType: "counterMonthly", valueFormat: "currency", source: { collectionName: "purchase-orders" }, permissionModule: "purchase-order", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__suppliers-count", metricKey: "suppliers-count", label: "Total Proveedores", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "suppliers" }, permissionModule: "supplier", active: true, target: "web", readonly: true, source_type: "default" },
  // Sales metrics (web)
  { id: "default__sale-orders-count", metricKey: "sale-orders-count", label: "Total Órdenes de Venta", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "sale-orders" }, permissionModule: "sale-order", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__sale-orders-total", metricKey: "sale-orders-total", label: "Monto Total Ventas", type: "sum", measureType: "counterMonthly", valueFormat: "currency", source: { collectionName: "sale-orders" }, permissionModule: "sale-order", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__quotations-count", metricKey: "quotations-count", label: "Total Cotizaciones", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "quotations" }, permissionModule: "quotation", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__quotations-confirmed-count", metricKey: "quotations-confirmed-count", label: "Cotizaciones Confirmadas", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "quotations" }, permissionModule: "quotation", active: true, target: "web", readonly: true, source_type: "default" },
  // Inventory metrics (web)
  { id: "default__products-count", metricKey: "products-count", label: "Total Productos", type: "entityCount", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "products" }, permissionModule: "product", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__stock-alerts-count", metricKey: "stock-alerts-count", label: "Alertas de Stock", type: "custom", measureType: "gaugeCurrent", valueFormat: "number", source: { collectionName: "stock-levels" }, permissionModule: "product", active: true, target: "web", readonly: true, source_type: "default" },
  { id: "default__inventory-movements-count", metricKey: "inventory-movements-count", label: "Total Movimientos Inventario", type: "entityCount", measureType: "counterMonthly", valueFormat: "number", source: { collectionName: "inventory-movements" }, permissionModule: "inventory-movement", active: true, target: "web", readonly: true, source_type: "default" },
];

export function getDefaultMetricDefinitions(): DefaultMetricDefinition[] {
  return DEFAULT_METRIC_DEFINITIONS.map(cloneDefault);
}

export function getDefaultMetricByKey(metricKey: string): DefaultMetricDefinition | null {
  const row = DEFAULT_METRIC_DEFINITIONS.find(m => m.metricKey === metricKey);
  return row ? cloneDefault(row) : null;
}

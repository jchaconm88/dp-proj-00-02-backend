import type { DefaultCardDefinition } from "./dashboard-catalog-types.js";
import { cloneDefault } from "./dashboard-catalog-types.js";

export const DEFAULT_CARD_DEFINITIONS: DefaultCardDefinition[] = [
  // Web operational cards
  { id: "default__trips-count-card", cardKey: "trips-count-card", metricKey: "trips-count", title: "Viajes", icon: "pi pi-map", accentClass: "text-blue-500", order: 10, visible: true, active: true, target: "web", permissionModule: "trip", readonly: true, source_type: "default" },
  { id: "default__trips-completed-card", cardKey: "trips-completed-card", metricKey: "trips-completed-vs-pending", title: "Viajes Completados", icon: "pi pi-check-circle", accentClass: "text-green-500", order: 20, visible: true, active: true, target: "web", permissionModule: "trip", readonly: true, source_type: "default" },
  { id: "default__settlements-count-card", cardKey: "settlements-count-card", metricKey: "settlements-count", title: "Liquidaciones", icon: "pi pi-wallet", accentClass: "text-purple-500", order: 30, visible: true, active: true, target: "web", permissionModule: "settlement", readonly: true, source_type: "default" },
  { id: "default__invoices-count-card", cardKey: "invoices-count-card", metricKey: "invoices-count", title: "Facturas", icon: "pi pi-file", accentClass: "text-orange-500", order: 40, visible: true, active: true, target: "web", permissionModule: "invoice", readonly: true, source_type: "default" },
  { id: "default__invoices-paid-card", cardKey: "invoices-paid-card", metricKey: "invoices-paid-vs-pending", title: "Facturas Pagadas", icon: "pi pi-check-square", accentClass: "text-teal-500", order: 50, visible: true, active: true, target: "web", permissionModule: "invoice", readonly: true, source_type: "default" },
  { id: "default__clients-count-card", cardKey: "clients-count-card", metricKey: "clients-count", title: "Clientes", icon: "pi pi-users", accentClass: "text-cyan-500", order: 60, visible: true, active: true, target: "web", permissionModule: "client", readonly: true, source_type: "default" },
  { id: "default__employees-count-card", cardKey: "employees-count-card", metricKey: "employees-count", title: "Empleados", icon: "pi pi-id-card", accentClass: "text-indigo-500", order: 70, visible: true, active: true, target: "web", permissionModule: "employee", readonly: true, source_type: "default" },
  { id: "default__vehicles-count-card", cardKey: "vehicles-count-card", metricKey: "vehicles-count", title: "Vehículos", icon: "pi pi-car", accentClass: "text-yellow-500", order: 80, visible: true, active: true, target: "web", permissionModule: "vehicle", readonly: true, source_type: "default" },
  { id: "default__drivers-count-card", cardKey: "drivers-count-card", metricKey: "drivers-count", title: "Operadores", icon: "pi pi-user", accentClass: "text-pink-500", order: 90, visible: true, active: true, target: "web", permissionModule: "driver", readonly: true, source_type: "default" },
  { id: "default__orders-count-card", cardKey: "orders-count-card", metricKey: "orders-count", title: "Órdenes", icon: "pi pi-box", accentClass: "text-lime-500", order: 100, visible: true, active: true, target: "web", permissionModule: "order", readonly: true, source_type: "default" },
  // Purchasing / sales / inventory (web) — métricas ya definidas en default-metric-definitions; faltaban tarjetas enlazadas
  { id: "default__purchase-orders-count-card", cardKey: "purchase-orders-count-card", metricKey: "purchase-orders-count", title: "Órdenes de compra", icon: "pi pi-shopping-cart", accentClass: "text-emerald-600", order: 110, visible: true, active: true, target: "web", permissionModule: "purchase-order", readonly: true, source_type: "default" },
  { id: "default__suppliers-count-card", cardKey: "suppliers-count-card", metricKey: "suppliers-count", title: "Proveedores", icon: "pi pi-building", accentClass: "text-emerald-700", order: 115, visible: true, active: true, target: "web", permissionModule: "supplier", readonly: true, source_type: "default" },
  { id: "default__sale-orders-count-card", cardKey: "sale-orders-count-card", metricKey: "sale-orders-count", title: "Órdenes de venta", icon: "pi pi-file-export", accentClass: "text-sky-600", order: 120, visible: true, active: true, target: "web", permissionModule: "sale-order", readonly: true, source_type: "default" },
  { id: "default__quotations-count-card", cardKey: "quotations-count-card", metricKey: "quotations-count", title: "Cotizaciones", icon: "pi pi-calculator", accentClass: "text-sky-700", order: 125, visible: true, active: true, target: "web", permissionModule: "quotation", readonly: true, source_type: "default" },
  { id: "default__products-count-card", cardKey: "products-count-card", metricKey: "products-count", title: "Productos", icon: "pi pi-tags", accentClass: "text-amber-600", order: 130, visible: true, active: true, target: "web", permissionModule: "product", readonly: true, source_type: "default" },
  { id: "default__inventory-movements-count-card", cardKey: "inventory-movements-count-card", metricKey: "inventory-movements-count", title: "Movimientos inventario", icon: "pi pi-sync", accentClass: "text-amber-700", order: 135, visible: true, active: true, target: "web", permissionModule: "inventory-movement", readonly: true, source_type: "default" },
  // Admin account-level cards
  { id: "default__report-runs-card", cardKey: "report-runs-card", metricKey: "report-runs", title: "Reportes Ejecutados", icon: "pi pi-chart-bar", accentClass: "text-blue-500", order: 10, visible: true, active: true, target: "admin", permissionModule: "report", readonly: true, source_type: "default" },
  { id: "default__emails-sent-card", cardKey: "emails-sent-card", metricKey: "emails-sent", title: "Correos Enviados", icon: "pi pi-envelope", accentClass: "text-green-500", order: 20, visible: true, active: true, target: "admin", permissionModule: "report", readonly: true, source_type: "default" },
  { id: "default__storage-used-card", cardKey: "storage-used-card", metricKey: "storage-bytes-used", title: "Almacenamiento", icon: "pi pi-database", accentClass: "text-orange-500", order: 30, visible: true, active: true, target: "admin", permissionModule: null, readonly: true, source_type: "default" },
];

export function getDefaultCardDefinitions(): DefaultCardDefinition[] {
  return DEFAULT_CARD_DEFINITIONS.map(cloneDefault);
}

export function getDefaultCardByKey(cardKey: string): DefaultCardDefinition | null {
  const row = DEFAULT_CARD_DEFINITIONS.find(c => c.cardKey === cardKey);
  return row ? cloneDefault(row) : null;
}

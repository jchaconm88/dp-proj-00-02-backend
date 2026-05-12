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

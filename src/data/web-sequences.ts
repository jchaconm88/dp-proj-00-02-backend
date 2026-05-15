import type { DefaultSequenceRecord } from "./sequence-types.js";
import { cloneDefaultSequence } from "./sequence-types.js";

const DEFAULT_FORMAT = "{prefix}-{year}-{number}";

export const WEB_SEQUENCES_CATALOG: DefaultSequenceRecord[] = [
  { id: "web-default__company", entity: "company", prefix: "COM", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__client", entity: "client", prefix: "CLI", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__trip", entity: "trip", prefix: "TRP", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__trip-stop", entity: "trip-stop", prefix: "STP", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__trip-assignment", entity: "trip-assignment", prefix: "ASN", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__trip-cost", entity: "trip-cost", prefix: "CST", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__trip-charge", entity: "trip-charge", prefix: "CHG", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__settlement", entity: "settlement", prefix: "SET", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__charge-type", entity: "charge-type", prefix: "CT", digits: 4, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__resource", entity: "resource", prefix: "RES", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__resource-cost", entity: "resource-cost", prefix: "RCO", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__position", entity: "position", prefix: "POS", digits: 4, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__employee", entity: "employee", prefix: "EMP", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__supplier", entity: "supplier", prefix: "PROV", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__product-category", entity: "product-category", prefix: "CAT", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__product", entity: "product", prefix: "PROD", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__warehouse", entity: "warehouse", prefix: "ALM", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__purchase-order", entity: "purchase-order", prefix: "OC", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__quotation", entity: "quotation", prefix: "COT", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__sale-order", entity: "sale-order", prefix: "OV", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "web-default__inventory-movement", entity: "inventory-movement", prefix: "MOV", digits: 6, format: DEFAULT_FORMAT, resetPeriod: "yearly", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
];

export function getWebSequences(): DefaultSequenceRecord[] {
  return WEB_SEQUENCES_CATALOG.map(cloneDefaultSequence).sort((a, b) => a.entity.localeCompare(b.entity));
}

export function getWebSequenceById(id: string): DefaultSequenceRecord | null {
  const row = WEB_SEQUENCES_CATALOG.find((s) => s.id === id);
  return row ? cloneDefaultSequence(row) : null;
}

export function getWebSequenceByEntity(entity: string): DefaultSequenceRecord | null {
  const normalized = String(entity ?? "").trim();
  const row = WEB_SEQUENCES_CATALOG.find((s) => s.entity === normalized);
  return row ? cloneDefaultSequence(row) : null;
}

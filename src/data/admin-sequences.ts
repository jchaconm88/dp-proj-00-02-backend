import type { DefaultSequenceRecord } from "./sequence-types.js";
import { cloneDefaultSequence } from "./sequence-types.js";

export const ADMIN_SEQUENCES_CATALOG: DefaultSequenceRecord[] = [
  { id: "admin-default__company", entity: "company", prefix: "COM", digits: 6, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "admin-default__web-user", entity: "web-user", prefix: "WUSR", digits: 6, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "admin-default__plan", entity: "plan", prefix: "PLAN", digits: 4, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
  { id: "admin-default__subscription", entity: "subscription", prefix: "SUB", digits: 6, format: "{prefix}-{number}", resetPeriod: "never", allowManualOverride: true, preventGaps: false, active: true, source: "default", readonly: true },
];

export function getAdminSequences(): DefaultSequenceRecord[] {
  return ADMIN_SEQUENCES_CATALOG.map(cloneDefaultSequence).sort((a, b) => a.entity.localeCompare(b.entity));
}

export function getAdminSequenceById(id: string): DefaultSequenceRecord | null {
  const row = ADMIN_SEQUENCES_CATALOG.find((s) => s.id === id);
  return row ? cloneDefaultSequence(row) : null;
}

export function getAdminSequenceByEntity(entity: string): DefaultSequenceRecord | null {
  const normalized = String(entity ?? "").trim();
  const row = ADMIN_SEQUENCES_CATALOG.find((s) => s.entity === normalized);
  return row ? cloneDefaultSequence(row) : null;
}

export type SequenceResetPeriod = "never" | "yearly" | "monthly" | "daily";

export interface DefaultSequenceRecord {
  id: string;
  entity: string;
  prefix: string;
  digits: number;
  format: string;
  resetPeriod: SequenceResetPeriod;
  allowManualOverride: boolean;
  preventGaps: boolean;
  active: boolean;
  source: "default";
  readonly: true;
}

export function cloneDefaultSequence(row: DefaultSequenceRecord): DefaultSequenceRecord {
  return { ...row, source: "default", readonly: true };
}

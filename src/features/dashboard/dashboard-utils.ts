import type { ValueFormat } from "./dashboard.types.js";

/**
 * Formats a raw numeric value according to the specified format.
 * - number: locale-formatted with thousand separators
 * - currency: $X,XXX.XX
 * - percentage: X%
 * - bytes: B / KB / MB / GB
 */
export function formatValue(rawValue: number, valueFormat: ValueFormat): string {
  switch (valueFormat) {
    case "currency":
      return `$${rawValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "percentage":
      return `${rawValue}%`;
    case "bytes": {
      if (rawValue < 1024) return `${rawValue} B`;
      if (rawValue < 1024 * 1024) return `${(rawValue / 1024).toFixed(1)} KB`;
      if (rawValue < 1024 * 1024 * 1024) return `${(rawValue / (1024 * 1024)).toFixed(1)} MB`;
      return `${(rawValue / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    case "number":
    default:
      return rawValue.toLocaleString("en-US");
  }
}

/**
 * Calculates progressPct for ratio metrics.
 * Returns (numerator / denominator) * 100, clamped to 0-100, rounded to integer.
 * Returns 0 if denominator is 0.
 */
export function computeRatioProgress(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const raw = (numerator / denominator) * 100;
  const clamped = Math.max(0, Math.min(100, raw));
  return Math.round(clamped);
}

/**
 * Generates the document ID for a dashboard snapshot.
 * - If companyId is null/undefined/empty: `{accountId}___{period}` (triple underscore)
 * - Otherwise: `{accountId}_{companyId}_{period}`
 */
export function buildSnapshotDocId(
  accountId: string,
  companyId: string | null | undefined,
  period: string
): string {
  if (!companyId) {
    return `${accountId}___${period}`;
  }
  return `${accountId}_${companyId}_${period}`;
}

/**
 * Returns the current period as YYYY-MM from UTC server date.
 */
export function getCurrentPeriod(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

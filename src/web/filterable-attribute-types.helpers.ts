/**
 * Helpers for filterable attribute types in product save operations.
 * Follows the same pattern as variant-attribute-types.helpers.ts.
 */

import type { Firestore } from "firebase-admin/firestore";

/**
 * Parses and normalizes a `filterableAttributes` input from the request body.
 * Returns a Record<string, string[]> where keys are normalized codes and values are arrays of strings.
 * Omits entries with empty arrays.
 */
export function parseFilterableAttributes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key ?? "").trim().toLowerCase();
    if (!code) continue;
    if (!Array.isArray(val)) continue;
    const values = val
      .map((v) => String(v ?? "").trim())
      .filter((v) => v !== "");
    if (values.length === 0) continue;
    out[code] = values;
  }
  return out;
}

/**
 * Resolves labels for filterable attribute codes from the catalog.
 *
 * - Queries the `filterable-attribute-types` collection for the given company/account.
 * - For each code in `filterableAttributes`, looks up the label in the catalog.
 * - Codes not found in the catalog are omitted (no error).
 * - If `filterableAttributes` is empty, returns `{}`.
 */
export async function denormalizeFilterableAttributeLabels(
  db: Firestore,
  companyId: string,
  accountId: string,
  filterableAttributes: Record<string, string[]>
): Promise<Record<string, string>> {
  if (!filterableAttributes || Object.keys(filterableAttributes).length === 0) {
    return {};
  }

  const snap = await db
    .collection("filterable-attribute-types")
    .where("companyId", "==", companyId)
    .where("accountId", "==", accountId)
    .get();

  const typeMap = new Map<string, string>();
  for (const doc of snap.docs) {
    const data = doc.data();
    typeMap.set(
      String(data.code ?? "").trim().toLowerCase(),
      String(data.label ?? "").trim()
    );
  }

  const labels: Record<string, string> = {};
  for (const code of Object.keys(filterableAttributes)) {
    const normalizedCode = code.trim().toLowerCase();
    const label = typeMap.get(normalizedCode);
    if (label) {
      labels[normalizedCode] = label;
    }
  }

  return labels;
}

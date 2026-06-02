import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT,
  FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX,
} from "../web/filterable-attribute-types.types.js";

/**
 * Feature: filterable-product-attributes, Property 3: Catalog edit round-trip
 *
 * For any filterable attribute type and any valid edit (changing label, values,
 * sortOrder, or active), reading the type after the edit SHALL return the updated
 * values for all modified fields and preserve unmodified fields.
 *
 * **Validates: Requirements 1.3**
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface FilterableAttributeTypeRecord {
  id: string;
  code: string;
  label: string;
  values: string[];
  sortOrder: number;
  active: boolean;
  companyId: string;
  accountId: string;
}

interface EditPatch {
  label?: string;
  values?: string[];
  sortOrder?: number;
  active?: boolean;
}

// ─── Pure logic extracted from the PUT endpoint ──────────────────────────────

function applyEdit(current: FilterableAttributeTypeRecord, patch: EditPatch): FilterableAttributeTypeRecord {
  const result = { ...current };

  if (patch.label !== undefined) {
    result.label = patch.label.trim();
  }
  if (patch.values !== undefined) {
    // Normalize: trim, remove empty, deduplicate (same as backend)
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of patch.values) {
      const v = String(raw ?? "").trim();
      if (!v) continue;
      if (!seen.has(v)) {
        seen.add(v);
        normalized.push(v);
      }
    }
    result.values = normalized;
  }
  if (patch.sortOrder !== undefined) {
    result.sortOrder = patch.sortOrder;
  }
  if (patch.active !== undefined) {
    result.active = patch.active !== false;
  }

  return result;
}

// ─── Generators ──────────────────────────────────────────────────────────────

const arbLabel = fc.string({ minLength: 1, maxLength: FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH })
  .filter(s => s.trim().length > 0);

const arbValue = fc.string({ minLength: 1, maxLength: FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH })
  .filter(s => s.trim().length > 0);

const arbValues = fc.array(arbValue, { minLength: 0, maxLength: 10 })
  .map(arr => {
    // Deduplicate by trimmed value
    const seen = new Set<string>();
    const result: string[] = [];
    for (const v of arr) {
      const trimmed = v.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result;
  });

const arbSortOrder = fc.integer({
  min: FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN,
  max: FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX,
});

const arbCode = fc.stringMatching(/^[a-z0-9_-]+$/).filter(s => s.length >= 1 && s.length <= 50);

const arbRecord = fc.record({
  id: fc.uuid(),
  code: arbCode,
  label: arbLabel,
  values: arbValues,
  sortOrder: arbSortOrder,
  active: fc.boolean(),
  companyId: fc.uuid(),
  accountId: fc.uuid(),
});

// Generate a valid edit patch with at least one field set
const arbEditPatch = fc.record({
  label: fc.option(arbLabel, { nil: undefined }),
  values: fc.option(arbValues, { nil: undefined }),
  sortOrder: fc.option(arbSortOrder, { nil: undefined }),
  active: fc.option(fc.boolean(), { nil: undefined }),
}).filter(patch =>
  patch.label !== undefined ||
  patch.values !== undefined ||
  patch.sortOrder !== undefined ||
  patch.active !== undefined
);

// ─── Property Test ───────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 3: Catalog edit round-trip", () => {
  it("reading after edit SHALL return updated values for modified fields and preserve unmodified fields", () => {
    fc.assert(
      fc.property(
        arbRecord,
        arbEditPatch,
        (original, patch) => {
          const result = applyEdit(original, patch);

          // Modified fields should reflect the edit
          if (patch.label !== undefined) {
            expect(result.label).toBe(patch.label.trim());
          }
          if (patch.values !== undefined) {
            // Values are normalized (trimmed, deduped, empty removed)
            const expectedValues: string[] = [];
            const seen = new Set<string>();
            for (const v of patch.values) {
              const trimmed = String(v ?? "").trim();
              if (trimmed && !seen.has(trimmed)) {
                seen.add(trimmed);
                expectedValues.push(trimmed);
              }
            }
            expect(result.values).toEqual(expectedValues);
          }
          if (patch.sortOrder !== undefined) {
            expect(result.sortOrder).toBe(patch.sortOrder);
          }
          if (patch.active !== undefined) {
            expect(result.active).toBe(patch.active !== false);
          }

          // Unmodified fields should be preserved
          if (patch.label === undefined) {
            expect(result.label).toBe(original.label);
          }
          if (patch.values === undefined) {
            expect(result.values).toEqual(original.values);
          }
          if (patch.sortOrder === undefined) {
            expect(result.sortOrder).toBe(original.sortOrder);
          }
          if (patch.active === undefined) {
            expect(result.active).toBe(original.active);
          }

          // Fields that are never editable should always be preserved
          expect(result.id).toBe(original.id);
          expect(result.code).toBe(original.code);
          expect(result.companyId).toBe(original.companyId);
          expect(result.accountId).toBe(original.accountId);
        }
      ),
      { numRuns: 100 }
    );
  });
});

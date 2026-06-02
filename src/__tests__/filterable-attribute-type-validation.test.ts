import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  FILTERABLE_ATTRIBUTE_TYPE_CODE_RE,
  FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT,
  FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX,
} from "../web/filterable-attribute-types.types.js";

// ─── Pure validation functions (mirror of inventory.router.ts logic) ─────────

/**
 * Validates the `code` field for a filterable attribute type.
 * Returns { valid: true } if code is acceptable, { valid: false, error } otherwise.
 */
function validateCode(code: unknown): { valid: boolean; error?: string } {
  const raw = String(code ?? "").trim().toLowerCase();
  if (!raw) return { valid: false, error: "code is required" };
  if (raw.length > FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH) {
    return { valid: false, error: `code must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH} characters` };
  }
  if (!FILTERABLE_ATTRIBUTE_TYPE_CODE_RE.test(raw)) {
    return { valid: false, error: "code must be lowercase alphanumeric with underscores or hyphens" };
  }
  return { valid: true };
}

/**
 * Validates the `label` field for a filterable attribute type.
 */
function validateLabel(label: unknown): { valid: boolean; error?: string } {
  const raw = String(label ?? "").trim();
  if (!raw) return { valid: false, error: "label is required" };
  if (raw.length > FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH) {
    return { valid: false, error: `label must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH} characters` };
  }
  return { valid: true };
}

/**
 * Validates the `values` array for a filterable attribute type.
 */
function validateValues(values: unknown): { valid: boolean; error?: string; normalized?: string[] } {
  if (!Array.isArray(values)) return { valid: false, error: "values must be an array" };
  if (values.length > FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT) {
    return { valid: false, error: `values must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT} items` };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    if (v.length > FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH) {
      return { valid: false, error: `each value must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH} characters` };
    }
    if (seen.has(v)) {
      return { valid: false, error: `duplicate value "${v}" in values array` };
    }
    seen.add(v);
    normalized.push(v);
  }
  return { valid: true, normalized };
}

/**
 * Validates the `sortOrder` field for a filterable attribute type.
 */
function validateSortOrder(sortOrder: unknown): { valid: boolean; value: number; error?: string } {
  const n = Number(sortOrder);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { valid: false, value: 0, error: "sortOrder must be an integer" };
  }
  if (n < FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN || n > FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX) {
    return { valid: false, value: 0, error: `sortOrder must be between ${FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN} and ${FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX}` };
  }
  return { valid: true, value: n };
}

/**
 * Full validation of a filterable attribute type creation input.
 * Returns true if all fields are valid, false otherwise.
 */
function validateCreateInput(input: {
  code: unknown;
  label: unknown;
  values: unknown;
  sortOrder: unknown;
}): boolean {
  const codeResult = validateCode(input.code);
  if (!codeResult.valid) return false;
  const labelResult = validateLabel(input.label);
  if (!labelResult.valid) return false;
  const valuesResult = validateValues(input.values);
  if (!valuesResult.valid) return false;
  const sortResult = validateSortOrder(input.sortOrder);
  if (!sortResult.valid) return false;
  return true;
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generator for valid codes: lowercase alphanumeric + underscore/hyphen, 1-50 chars */
const validCodeArb = fc.stringMatching(/^[a-z0-9_-]{1,50}$/);

/** Generator for valid labels: non-empty, 1-100 chars (printable) */
const validLabelArb = fc.string({ minLength: 1, maxLength: FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH })
  .filter(s => s.trim().length > 0);

/** Generator for a single valid value: non-empty, 1-100 chars (printable) */
const validValueArb = fc.string({ minLength: 1, maxLength: FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH })
  .filter(s => s.trim().length > 0);

/** Generator for valid values array: unique elements, max 200 */
const validValuesArb = fc.uniqueArray(validValueArb, {
  maxLength: FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT,
  comparator: (a, b) => a.trim() === b.trim(),
});

/** Generator for valid sortOrder: integer 0-9999 */
const validSortOrderArb = fc.integer({
  min: FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN,
  max: FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX,
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 1: Catalog field validation", () => {
  /**
   * **Validates: Requirements 1.1, 7.7**
   *
   * For any input to create a filterable attribute type, the system SHALL accept
   * the creation if and only if: `code` matches `^[a-z0-9_-]+$` and is ≤ 50 characters,
   * `label` is non-empty and ≤ 100 characters, `values` is an array of ≤ 200 elements
   * where each element is 1–100 characters with no duplicates, and `sortOrder` is an
   * integer 0–9999.
   */

  it("should ACCEPT any input where all fields satisfy the validation rules", () => {
    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        validValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when code contains invalid characters (uppercase, spaces, special chars)", () => {
    const invalidCodeArb = fc.string({ minLength: 1, maxLength: 50 })
      .filter(s => {
        const trimmed = s.trim().toLowerCase();
        return trimmed.length > 0 && !FILTERABLE_ATTRIBUTE_TYPE_CODE_RE.test(trimmed);
      });

    fc.assert(
      fc.property(
        invalidCodeArb,
        validLabelArb,
        validValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when code exceeds 50 characters", () => {
    const longCodeArb = fc.stringMatching(/^[a-z0-9_-]{51,80}$/);

    fc.assert(
      fc.property(
        longCodeArb,
        validLabelArb,
        validValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when label is empty or whitespace-only", () => {
    const emptyLabelArb = fc.constantFrom("", "   ", "\t", "\n", "  \t  ");

    fc.assert(
      fc.property(
        validCodeArb,
        emptyLabelArb,
        validValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when label exceeds 100 characters", () => {
    const longLabelArb = fc.string({
      minLength: FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH + 1,
      maxLength: 200,
    }).filter(s => s.trim().length > FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH);

    fc.assert(
      fc.property(
        validCodeArb,
        longLabelArb,
        validValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when values array exceeds 200 elements", () => {
    // Generate an array with more than 200 unique elements
    const tooManyValuesArb = fc.integer({ min: FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT + 1, max: 210 })
      .map(count => Array.from({ length: count }, (_, i) => `value_${i}`));

    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        tooManyValuesArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when a value in the array exceeds 100 characters", () => {
    const longValueArb = fc.string({
      minLength: FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH + 1,
      maxLength: 150,
    }).filter(s => s.trim().length > FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH);

    const valuesWithLongItemArb = fc.tuple(
      fc.uniqueArray(validValueArb, { minLength: 0, maxLength: 5 }),
      longValueArb
    ).map(([validValues, longValue]) => [...validValues, longValue]);

    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        valuesWithLongItemArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when values array contains duplicates", () => {
    const valuesWithDuplicateArb = validValueArb.chain(value =>
      fc.uniqueArray(validValueArb, { minLength: 0, maxLength: 5 })
        .filter(arr => !arr.some(v => v.trim() === value.trim()))
        .map(arr => [...arr, value, value])
    );

    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        valuesWithDuplicateArb,
        validSortOrderArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when sortOrder is not an integer", () => {
    const nonIntegerArb = fc.double({ min: 0.01, max: 9999, noNaN: true })
      .filter(n => !Number.isInteger(n));

    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        validValuesArb,
        nonIntegerArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when sortOrder is outside range 0-9999", () => {
    const outOfRangeArb = fc.oneof(
      fc.integer({ min: -1000, max: -1 }),
      fc.integer({ min: 10000, max: 20000 })
    );

    fc.assert(
      fc.property(
        validCodeArb,
        validLabelArb,
        validValuesArb,
        outOfRangeArb,
        (code, label, values, sortOrder) => {
          const result = validateCreateInput({ code, label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should REJECT when code is empty", () => {
    fc.assert(
      fc.property(
        validLabelArb,
        validValuesArb,
        validSortOrderArb,
        (label, values, sortOrder) => {
          const result = validateCreateInput({ code: "", label, values, sortOrder });
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

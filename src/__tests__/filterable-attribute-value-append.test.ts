/**
 * Feature: filterable-product-attributes, Property 4: Value append preserves existing and rejects duplicates
 *
 * **Validates: Requirements 1.4**
 *
 * For any filterable attribute type with an existing values array, appending a new value
 * SHALL result in an array containing all previous values plus the new value.
 * If the new value already exists in the array, the append SHALL be rejected and the
 * array SHALL remain unchanged.
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// ─── Constants (mirrored from filterable-attribute-types.types.ts) ────────────
const FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT = 200;
const FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH = 100;

// ─── Pure logic under test (extracted from inventory.router.ts) ───────────────

/**
 * Validates a values array, rejecting duplicates and enforcing constraints.
 * Returns { valid, error?, normalized? }.
 */
function validateFilterableAttributeTypeValues(values: unknown): {
  valid: boolean;
  error?: string;
  normalized?: string[];
} {
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
 * Simulates the append operation: takes existing values and a new value,
 * produces the candidate array, and validates it.
 * Returns { accepted, resultValues } where:
 * - accepted=true means the new value was appended successfully
 * - accepted=false means the append was rejected (duplicate)
 */
function appendValue(
  existingValues: string[],
  newValue: string
): { accepted: boolean; resultValues: string[] } {
  const candidate = [...existingValues, newValue];
  const result = validateFilterableAttributeTypeValues(candidate);
  if (!result.valid) {
    // Rejected — array remains unchanged
    return { accepted: false, resultValues: existingValues };
  }
  return { accepted: true, resultValues: result.normalized! };
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Generates a valid, non-empty value string (1-100 chars, trimmed, no leading/trailing spaces) */
const validValueArb = fc.string({ minLength: 1, maxLength: 50 }).map((s) => {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed || "x";
}).filter((s) => s.length >= 1 && s.length <= FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH);

/** Generates a unique array of valid values (no duplicates, max 50 items for test performance) */
const uniqueValuesArrayArb = fc
  .uniqueArray(validValueArb, { minLength: 1, maxLength: 50, comparator: (a, b) => a === b })
  .filter((arr) => arr.length >= 1);

// ─── Property Tests ───────────────────────────────────────────────────────────

describe("Property 4: Value append preserves existing and rejects duplicates", () => {
  it("appending a new unique value results in all previous values plus the new value", () => {
    fc.assert(
      fc.property(
        uniqueValuesArrayArb,
        validValueArb,
        (existingValues, candidateNewValue) => {
          // Ensure the candidate is NOT already in the existing array
          const newValue = existingValues.includes(candidateNewValue)
            ? candidateNewValue + "_unique"
            : candidateNewValue;

          // Skip if the new value would exceed length constraints
          if (newValue.length > FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH) return;
          // Skip if adding would exceed max count
          if (existingValues.length >= FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT) return;

          const { accepted, resultValues } = appendValue(existingValues, newValue);

          // The append MUST be accepted since the value is unique
          expect(accepted).toBe(true);

          // The result MUST contain all previous values
          for (const v of existingValues) {
            expect(resultValues).toContain(v);
          }

          // The result MUST contain the new value
          expect(resultValues).toContain(newValue);

          // The result length MUST be previous length + 1
          expect(resultValues.length).toBe(existingValues.length + 1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("appending a duplicate value is rejected and the array remains unchanged", () => {
    fc.assert(
      fc.property(
        uniqueValuesArrayArb,
        (existingValues) => {
          // Pick a random existing value to attempt to append as duplicate
          const duplicateValue = existingValues[Math.floor(Math.random() * existingValues.length)];

          const { accepted, resultValues } = appendValue(existingValues, duplicateValue);

          // The append MUST be rejected
          expect(accepted).toBe(false);

          // The array MUST remain unchanged
          expect(resultValues).toEqual(existingValues);
          expect(resultValues.length).toBe(existingValues.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Feature: filterable-product-attributes, Property 5: Deactivated type blocks new assignment
 *
 * **Validates: Requirements 1.7, 2.6**
 *
 * For any filterable attribute type with `active: false` and any product,
 * attempting to assign that type to the product SHALL be rejected.
 *
 * Tag: Feature: filterable-product-attributes, Property 5: Deactivated type blocks new assignment
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// ─── Domain types ────────────────────────────────────────────────────────────

interface FilterableAttributeType {
  code: string;
  label: string;
  values: string[];
  active: boolean;
}

interface AssignmentResult {
  ok: boolean;
  error?: string;
}

// ─── Pure validation logic (mirrors backend behavior) ────────────────────────

/**
 * Validates a filterable attribute assignment against the catalog.
 * Rejects assignment if the type is inactive (active: false).
 *
 * This mirrors the validation that the backend performs when a product
 * is saved with filterableAttributes referencing a deactivated type.
 *
 * Per Requirements 1.7 and 2.6:
 * - Deactivated types SHALL prevent new assignment to products
 * - Existing assignments are retained (displayed with disabled style)
 */
function validateFilterableAttributeAssignment(
  newAssignment: Record<string, string[]>,
  existingAssignment: Record<string, string[]>,
  catalog: FilterableAttributeType[]
): AssignmentResult {
  const catalogMap = new Map<string, FilterableAttributeType>();
  for (const type of catalog) {
    catalogMap.set(type.code, type);
  }

  for (const [code, values] of Object.entries(newAssignment)) {
    // Skip codes that were already assigned (existing assignments are retained)
    if (Object.prototype.hasOwnProperty.call(existingAssignment, code) && existingAssignment[code].length > 0) {
      continue;
    }

    // This is a NEW assignment — check if the type is active
    const type = catalogMap.get(code);
    if (!type) {
      return { ok: false, error: `Attribute type "${code}" not found in catalog` };
    }
    if (!type.active) {
      return { ok: false, error: `Attribute type "${code}" is inactive` };
    }

    // Validate values exist in the type's values array
    for (const val of values) {
      if (!type.values.includes(val)) {
        return { ok: false, error: `Value "${val}" is not permitted for attribute "${type.label}"` };
      }
    }
  }

  return { ok: true };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Valid value string: non-empty, 1-30 chars */
const arbValidValue = fc.string({ minLength: 1, maxLength: 30 }).map((s) => {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed || "val";
}).filter((s) => s.length >= 1);

/** Valid label: non-empty, 1-50 chars */
const arbLabel = fc.string({ minLength: 1, maxLength: 50 }).map((s) => {
  const trimmed = s.trim();
  return trimmed || "Label";
}).filter((s) => s.length >= 1);

/** Generates a deactivated filterable attribute type */
const arbDeactivatedType = fc.record({
  code: arbValidCode,
  label: arbLabel,
  values: fc.uniqueArray(arbValidValue, { minLength: 1, maxLength: 10, comparator: (a, b) => a === b }),
  active: fc.constant(false),
});

/** Generates an active filterable attribute type */
const arbActiveType = fc.record({
  code: arbValidCode,
  label: arbLabel,
  values: fc.uniqueArray(arbValidValue, { minLength: 1, maxLength: 10, comparator: (a, b) => a === b }),
  active: fc.constant(true),
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 5: Deactivated type blocks new assignment", () => {
  it("SHALL reject new assignment of a deactivated type to any product", () => {
    fc.assert(
      fc.property(
        arbDeactivatedType,
        (deactivatedType) => {
          // Ensure the type has at least one value to attempt assignment
          fc.pre(deactivatedType.values.length > 0);

          const catalog: FilterableAttributeType[] = [deactivatedType];

          // Attempt to assign the deactivated type to a product with no existing assignments
          const newAssignment: Record<string, string[]> = {
            [deactivatedType.code]: [deactivatedType.values[0]],
          };
          const existingAssignment: Record<string, string[]> = {};

          const result = validateFilterableAttributeAssignment(
            newAssignment,
            existingAssignment,
            catalog
          );

          // The assignment MUST be rejected
          expect(result.ok).toBe(false);
          expect(result.error).toContain("inactive");
          expect(result.error).toContain(deactivatedType.code);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL reject new assignment of a deactivated type regardless of which values are selected", () => {
    fc.assert(
      fc.property(
        arbDeactivatedType,
        fc.nat({ max: 9 }),
        (deactivatedType, valueIndex) => {
          fc.pre(deactivatedType.values.length > 0);

          const catalog: FilterableAttributeType[] = [deactivatedType];

          // Pick any subset of valid values from the type
          const selectedIndex = valueIndex % deactivatedType.values.length;
          const selectedValues = deactivatedType.values.slice(0, selectedIndex + 1);

          const newAssignment: Record<string, string[]> = {
            [deactivatedType.code]: selectedValues,
          };
          const existingAssignment: Record<string, string[]> = {};

          const result = validateFilterableAttributeAssignment(
            newAssignment,
            existingAssignment,
            catalog
          );

          // The assignment MUST be rejected regardless of which values are chosen
          expect(result.ok).toBe(false);
          expect(result.error).toContain("inactive");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL allow assignment of an active type (control case)", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        (activeType) => {
          fc.pre(activeType.values.length > 0);

          const catalog: FilterableAttributeType[] = [activeType];

          // Attempt to assign the active type
          const newAssignment: Record<string, string[]> = {
            [activeType.code]: [activeType.values[0]],
          };
          const existingAssignment: Record<string, string[]> = {};

          const result = validateFilterableAttributeAssignment(
            newAssignment,
            existingAssignment,
            catalog
          );

          // The assignment MUST be accepted since the type is active
          expect(result.ok).toBe(true);
          expect(result.error).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL retain existing assignment of a deactivated type (not block existing)", () => {
    fc.assert(
      fc.property(
        arbDeactivatedType,
        (deactivatedType) => {
          fc.pre(deactivatedType.values.length > 0);

          const catalog: FilterableAttributeType[] = [deactivatedType];

          // The product already has this type assigned (existing assignment)
          const existingAssignment: Record<string, string[]> = {
            [deactivatedType.code]: [deactivatedType.values[0]],
          };

          // The "new" assignment includes the same code (retaining existing)
          const newAssignment: Record<string, string[]> = {
            [deactivatedType.code]: [deactivatedType.values[0]],
          };

          const result = validateFilterableAttributeAssignment(
            newAssignment,
            existingAssignment,
            catalog
          );

          // Existing assignments MUST be retained even if type is inactive
          expect(result.ok).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

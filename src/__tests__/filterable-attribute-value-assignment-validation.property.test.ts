/**
 * Feature: filterable-product-attributes, Property 7: Value assignment validation
 *
 * **Validates: Requirements 2.3, 2.4**
 *
 * For any product and any filterable attribute type, assigning a value that does
 * NOT exist in the type's `values` array SHALL be rejected, and the product's
 * `filterableAttributes` SHALL remain unchanged.
 *
 * Tag: Feature: filterable-product-attributes, Property 7: Value assignment validation
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

interface Product {
  id: string;
  filterableAttributes: Record<string, string[]>;
}

interface AssignmentResult {
  ok: boolean;
  error?: string;
  product: Product;
}

// ─── Pure validation logic (mirrors backend behavior) ────────────────────────

/**
 * Validates and applies a filterable attribute value assignment to a product.
 *
 * Per Requirements 2.3 and 2.4:
 * - The system SHALL validate that assigned values exist in the type's values array.
 * - If a value does NOT exist, the assignment SHALL be rejected and the product's
 *   filterableAttributes SHALL remain unchanged.
 */
function assignFilterableAttributeValues(
  product: Product,
  code: string,
  valuesToAssign: string[],
  catalog: FilterableAttributeType[]
): AssignmentResult {
  const type = catalog.find((t) => t.code === code);
  if (!type) {
    return {
      ok: false,
      error: `Attribute type "${code}" not found in catalog`,
      product,
    };
  }

  // Validate each value exists in the type's values array
  for (const val of valuesToAssign) {
    if (!type.values.includes(val)) {
      // Reject: product remains unchanged
      return {
        ok: false,
        error: `Value "${val}" is not permitted for attribute "${type.label}"`,
        product,
      };
    }
  }

  // All values are valid — apply assignment
  const updatedProduct: Product = {
    ...product,
    filterableAttributes: {
      ...product.filterableAttributes,
      [code]: valuesToAssign,
    },
  };

  return { ok: true, product: updatedProduct };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Valid value string: non-empty, 1-30 chars, printable */
const arbValidValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter((s) => s.length >= 1);

/** Valid label: non-empty, 1-50 chars */
const arbLabel = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => s.trim())
  .filter((s) => s.length >= 1);

/** Generates an active filterable attribute type with unique values */
const arbActiveType = fc.record({
  code: arbValidCode,
  label: arbLabel,
  values: fc.uniqueArray(arbValidValue, {
    minLength: 1,
    maxLength: 10,
    comparator: (a, b) => a === b,
  }),
  active: fc.constant(true),
});

/** Generates a value guaranteed NOT to be in a given values array */
function arbInvalidValue(existingValues: string[]): fc.Arbitrary<string> {
  return arbValidValue.filter((v) => !existingValues.includes(v));
}

/** Generates a product ID */
const arbProductId = fc.stringMatching(/^[a-z0-9]{8,16}$/);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 7: Value assignment validation", () => {
  it("SHALL reject assignment of a value NOT in the type's values array", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        arbProductId,
        (type, productId) => {
          fc.pre(type.values.length >= 1);

          const catalog: FilterableAttributeType[] = [type];
          const product: Product = {
            id: productId,
            filterableAttributes: {},
          };

          // Generate a value that is NOT in the type's values array
          // Use a deterministic approach: append a unique suffix to ensure it's not in the array
          const invalidValue = type.values[0] + "__INVALID_SUFFIX_XYZ__";

          const result = assignFilterableAttributeValues(
            product,
            type.code,
            [invalidValue],
            catalog
          );

          // Assignment MUST be rejected
          expect(result.ok).toBe(false);
          expect(result.error).toContain("not permitted");
          expect(result.error).toContain(invalidValue);

          // Product's filterableAttributes MUST remain unchanged
          expect(result.product.filterableAttributes).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL reject assignment when ANY value in the array is invalid", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        arbProductId,
        fc.nat({ max: 9 }),
        (type, productId, insertIndex) => {
          fc.pre(type.values.length >= 2);

          const catalog: FilterableAttributeType[] = [type];
          const product: Product = {
            id: productId,
            filterableAttributes: {},
          };

          // Mix valid values with one invalid value
          const validValues = type.values.slice(0, 2);
          const invalidValue = type.values[0] + "__NOT_IN_CATALOG__";
          const mixedValues = [...validValues];
          const idx = insertIndex % (mixedValues.length + 1);
          mixedValues.splice(idx, 0, invalidValue);

          const result = assignFilterableAttributeValues(
            product,
            type.code,
            mixedValues,
            catalog
          );

          // Assignment MUST be rejected because at least one value is invalid
          expect(result.ok).toBe(false);
          expect(result.error).toContain("not permitted");

          // Product's filterableAttributes MUST remain unchanged
          expect(result.product.filterableAttributes).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL accept assignment when ALL values exist in the type's values array", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        arbProductId,
        (type, productId) => {
          fc.pre(type.values.length >= 1);

          const catalog: FilterableAttributeType[] = [type];
          const product: Product = {
            id: productId,
            filterableAttributes: {},
          };

          // Use only valid values from the type's values array
          const validValues = [type.values[0]];

          const result = assignFilterableAttributeValues(
            product,
            type.code,
            validValues,
            catalog
          );

          // Assignment MUST be accepted
          expect(result.ok).toBe(true);
          expect(result.error).toBeUndefined();

          // Product's filterableAttributes MUST be updated
          expect(result.product.filterableAttributes[type.code]).toEqual(validValues);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL preserve existing filterableAttributes when assignment is rejected", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        arbActiveType,
        arbProductId,
        (typeA, typeB, productId) => {
          // Ensure types have different codes and at least one value each
          fc.pre(typeA.code !== typeB.code);
          fc.pre(typeA.values.length >= 1);
          fc.pre(typeB.values.length >= 1);

          const catalog: FilterableAttributeType[] = [typeA, typeB];

          // Product already has a valid assignment for typeA
          const existingAttrs: Record<string, string[]> = {
            [typeA.code]: [typeA.values[0]],
          };
          const product: Product = {
            id: productId,
            filterableAttributes: existingAttrs,
          };

          // Attempt to assign an invalid value for typeB
          const invalidValue = typeB.values[0] + "__DOES_NOT_EXIST__";

          const result = assignFilterableAttributeValues(
            product,
            typeB.code,
            [invalidValue],
            catalog
          );

          // Assignment MUST be rejected
          expect(result.ok).toBe(false);

          // Existing filterableAttributes MUST remain unchanged
          expect(result.product.filterableAttributes).toEqual(existingAttrs);
          expect(result.product.filterableAttributes[typeA.code]).toEqual([typeA.values[0]]);
          // typeB should NOT appear in the product
          expect(result.product.filterableAttributes[typeB.code]).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL accept multiple valid values for the same attribute type", () => {
    fc.assert(
      fc.property(
        arbActiveType,
        arbProductId,
        (type, productId) => {
          // Need at least 2 values to test multi-value assignment
          fc.pre(type.values.length >= 2);

          const catalog: FilterableAttributeType[] = [type];
          const product: Product = {
            id: productId,
            filterableAttributes: {},
          };

          // Assign multiple valid values
          const multipleValues = type.values.slice(0, Math.min(type.values.length, 3));

          const result = assignFilterableAttributeValues(
            product,
            type.code,
            multipleValues,
            catalog
          );

          // Assignment MUST be accepted
          expect(result.ok).toBe(true);
          expect(result.product.filterableAttributes[type.code]).toEqual(multipleValues);
        }
      ),
      { numRuns: 100 }
    );
  });
});

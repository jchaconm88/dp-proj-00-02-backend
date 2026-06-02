/**
 * Feature: filterable-product-attributes, Property 6: Product filterableAttributes round-trip
 *
 * **Validates: Requirements 2.1, 2.5, 2.7**
 *
 * For any product and any valid `filterableAttributes` map (where keys are existing
 * active type codes and values are arrays of strings from the type's values array),
 * saving and then reading the product SHALL return the same `filterableAttributes` map.
 * Products with zero filterable attributes SHALL store an empty map.
 *
 * Tag: Feature: filterable-product-attributes, Property 6: Product filterableAttributes round-trip
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { parseFilterableAttributes } from "../web/filterable-attribute-types.helpers.js";

// ─── Domain types ────────────────────────────────────────────────────────────

interface FilterableAttributeType {
  code: string;
  label: string;
  values: string[];
  active: boolean;
}

// ─── In-memory product store simulating Firestore save/read ──────────────────

class ProductStore {
  private products = new Map<string, Record<string, unknown>>();
  private nextId = 1;

  /**
   * Simulates saving a product with filterableAttributes.
   * Uses parseFilterableAttributes to normalize the input (same as inventory.router.ts).
   */
  save(
    rawFilterableAttributes: unknown,
    catalog: FilterableAttributeType[]
  ): { ok: true; id: string } | { ok: false; error: string } {
    const filterableAttributes = parseFilterableAttributes(rawFilterableAttributes);

    // Validate: only active type codes allowed for new assignments
    for (const code of Object.keys(filterableAttributes)) {
      const type = catalog.find((t) => t.code === code);
      if (!type) {
        return { ok: false, error: `Attribute type "${code}" not found in catalog` };
      }
      if (!type.active) {
        return { ok: false, error: `Attribute type "${code}" is inactive` };
      }
      // Validate values exist in the type's values array
      for (const val of filterableAttributes[code]) {
        if (!type.values.includes(val)) {
          return { ok: false, error: `Value "${val}" is not permitted for attribute "${type.label}"` };
        }
      }
    }

    const id = `prod_${this.nextId++}`;
    this.products.set(id, { filterableAttributes });
    return { ok: true, id };
  }

  /**
   * Simulates reading a product's filterableAttributes.
   * Returns the stored map (which was already normalized on save).
   */
  read(id: string): Record<string, string[]> {
    const product = this.products.get(id);
    if (!product) return {};
    return (product.filterableAttributes as Record<string, string[]>) ?? {};
  }
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Valid value string: non-empty, trimmed, 1-30 chars */
const arbValidValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => {
    const trimmed = s.replace(/\s+/g, " ").trim();
    return trimmed || "val";
  })
  .filter((s) => s.length >= 1 && s.length <= 30);

/** Generates an active filterable attribute type with unique values */
const arbActiveType = fc.record({
  code: arbValidCode,
  label: fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.trim() || "Label"),
  values: fc.uniqueArray(arbValidValue, {
    minLength: 1,
    maxLength: 10,
    comparator: (a, b) => a === b,
  }),
  active: fc.constant(true as const),
});

/** Generates a catalog of active types with unique codes */
const arbCatalog = fc
  .uniqueArray(arbActiveType, {
    minLength: 1,
    maxLength: 5,
    comparator: (a, b) => a.code === b.code,
  })
  .filter((arr) => arr.length >= 1);

/**
 * Generates a valid filterableAttributes map based on a catalog.
 * Keys are codes from the catalog, values are subsets of the type's values array.
 */
function arbValidFilterableAttributes(catalog: FilterableAttributeType[]) {
  // For each type in the catalog, optionally include it with a subset of its values
  return fc.tuple(
    ...catalog.map((type) =>
      fc.tuple(
        fc.boolean(), // whether to include this type
        fc.subarray(type.values, { minLength: 1, maxLength: type.values.length })
      )
    )
  ).map((selections) => {
    const attrs: Record<string, string[]> = {};
    for (let i = 0; i < catalog.length; i++) {
      const [include, values] = selections[i];
      if (include && values.length > 0) {
        attrs[catalog[i].code] = values;
      }
    }
    return attrs;
  });
}

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 6: Product filterableAttributes round-trip", () => {
  it("saving and reading a valid filterableAttributes map SHALL return the same map", () => {
    fc.assert(
      fc.property(
        arbCatalog,
        (catalog) => {
          // Generate a valid filterableAttributes map from the catalog
          fc.assert(
            fc.property(
              arbValidFilterableAttributes(catalog),
              (validAttrs) => {
                const store = new ProductStore();

                // Save the product with valid filterableAttributes
                const saveResult = store.save(validAttrs, catalog);

                // Save MUST succeed since all codes are active and values are valid
                expect(saveResult.ok).toBe(true);
                if (!saveResult.ok) return;

                // Read the product back
                const readAttrs = store.read(saveResult.id);

                // The read map MUST equal the saved map (round-trip)
                expect(readAttrs).toEqual(validAttrs);
              }
            ),
            { numRuns: 20 } // inner loop
          );
        }
      ),
      { numRuns: 5 } // outer loop: 5 catalogs × 20 maps = 100 iterations
    );
  });

  it("products with zero filterable attributes SHALL store an empty map", () => {
    fc.assert(
      fc.property(
        arbCatalog,
        (catalog) => {
          const store = new ProductStore();

          // Save with empty filterableAttributes
          const saveResult = store.save({}, catalog);
          expect(saveResult.ok).toBe(true);
          if (!saveResult.ok) return;

          // Read back — should be empty map
          const readAttrs = store.read(saveResult.id);
          expect(readAttrs).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });

  it("parseFilterableAttributes is idempotent for already-normalized maps", () => {
    fc.assert(
      fc.property(
        arbCatalog,
        (catalog) => {
          fc.assert(
            fc.property(
              arbValidFilterableAttributes(catalog),
              (validAttrs) => {
                // A valid map (lowercase codes, array values, non-empty) should be
                // unchanged after passing through parseFilterableAttributes
                const parsed = parseFilterableAttributes(validAttrs);
                expect(parsed).toEqual(validAttrs);

                // Applying parseFilterableAttributes again should yield the same result
                const parsedAgain = parseFilterableAttributes(parsed);
                expect(parsedAgain).toEqual(parsed);
              }
            ),
            { numRuns: 20 }
          );
        }
      ),
      { numRuns: 5 }
    );
  });

  it("multiple filterable attributes per product are preserved (Req 2.7)", () => {
    fc.assert(
      fc.property(
        arbCatalog.filter((c) => c.length >= 2),
        (catalog) => {
          const store = new ProductStore();

          // Assign values from ALL types in the catalog
          const allAttrs: Record<string, string[]> = {};
          for (const type of catalog) {
            if (type.values.length > 0) {
              allAttrs[type.code] = type.values.slice(0, Math.min(3, type.values.length));
            }
          }

          // Skip if no attributes to assign
          if (Object.keys(allAttrs).length === 0) return;

          const saveResult = store.save(allAttrs, catalog);
          expect(saveResult.ok).toBe(true);
          if (!saveResult.ok) return;

          const readAttrs = store.read(saveResult.id);

          // ALL assigned attributes MUST be preserved
          expect(Object.keys(readAttrs).length).toBe(Object.keys(allAttrs).length);
          for (const [code, values] of Object.entries(allAttrs)) {
            expect(readAttrs[code]).toEqual(values);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

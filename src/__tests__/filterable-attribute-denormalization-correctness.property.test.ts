/**
 * Feature: filterable-product-attributes, Property 13: Denormalization correctness
 *
 * **Validates: Requirements 8.1, 8.2, 8.5**
 *
 * For any product saved with `filterableAttributes`, the `filterableAttributeLabels`
 * field SHALL contain exactly the codes present in `filterableAttributes` that also
 * exist in the `filterable-attribute-types` catalog. Codes not found in the catalog
 * SHALL be omitted from `filterableAttributeLabels`. Each included code's label SHALL
 * match the catalog's current `label` value.
 *
 * Tag: Feature: filterable-product-attributes, Property 13: Denormalization correctness
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { denormalizeFilterableAttributeLabels } from "../web/filterable-attribute-types.helpers.js";

// ─── Domain types ────────────────────────────────────────────────────────────

interface CatalogEntry {
  code: string;
  label: string;
  companyId: string;
  accountId: string;
}

// ─── Mock Firestore ──────────────────────────────────────────────────────────

/**
 * Creates a mock Firestore instance that returns the given catalog docs
 * when queried with matching companyId and accountId.
 */
function createMockDb(catalogDocs: CatalogEntry[]) {
  return {
    collection: (_name: string) => ({
      where: (field: string, _op: string, value: string) => {
        const filters: Record<string, string> = { [field]: value };
        const chainable = {
          where: (f2: string, _op2: string, v2: string) => {
            filters[f2] = v2;
            return chainable;
          },
          get: async () => {
            const matchingDocs = catalogDocs
              .filter(
                (d) =>
                  d.companyId === filters["companyId"] &&
                  d.accountId === filters["accountId"]
              )
              .map((d) => ({
                data: () => d,
              }));
            return { docs: matchingDocs };
          },
        };
        return chainable;
      },
    }),
  } as unknown as FirebaseFirestore.Firestore;
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars (excluding prototype-polluting keys) */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Non-empty label string, 1-50 chars, trimmed and guaranteed non-empty */
const arbLabel = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => {
    const trimmed = s.trim();
    return trimmed || "Label";
  });

/** Non-empty value string */
const arbValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => {
    const trimmed = s.replace(/\s+/g, " ").trim();
    return trimmed || "val";
  });

/** Generates a catalog entry with a valid code and non-empty label */
const arbCatalogEntry = fc.record({
  code: arbValidCode,
  label: arbLabel,
});

/** Generates a catalog with unique codes */
const arbCatalog = fc.uniqueArray(arbCatalogEntry, {
  minLength: 1,
  maxLength: 8,
  comparator: (a, b) => a.code === b.code,
});

/**
 * Generates a scenario with a catalog and a filterableAttributes map that
 * contains a mix of codes from the catalog and codes NOT in the catalog.
 */
const arbDenormalizationScenario = arbCatalog.chain((catalog) => {
  const catalogCodes = catalog.map((c) => c.code);
  const catalogCodeSet = new Set(catalogCodes.map((c) => c.trim().toLowerCase()));

  // Codes from the catalog (subset)
  const arbFromCatalog = fc.subarray(catalogCodes, {
    minLength: 0,
    maxLength: catalogCodes.length,
  });

  // Codes NOT in the catalog
  const arbExtraCodes = fc
    .array(arbValidCode, { minLength: 0, maxLength: 3 })
    .map((codes) =>
      codes.filter((c) => c.trim().toLowerCase().length > 0 && !catalogCodeSet.has(c.trim().toLowerCase()))
    );

  return fc.tuple(fc.constant(catalog), arbFromCatalog, arbExtraCodes).map(
    ([cat, fromCatalog, extraCodes]) => {
      const filterableAttributes: Record<string, string[]> = {};
      for (const code of fromCatalog) {
        filterableAttributes[code] = ["someValue"];
      }
      for (const code of extraCodes) {
        filterableAttributes[code] = ["someValue"];
      }
      return { catalog: cat, filterableAttributes };
    }
  );
});

/**
 * Generates a scenario with ONLY non-catalog codes in filterableAttributes.
 */
const arbNonCatalogOnlyScenario = arbCatalog.chain((catalog) => {
  const catalogCodeSet = new Set(
    catalog.map((c) => c.code.trim().toLowerCase())
  );

  const arbExtraCodes = fc
    .array(arbValidCode, { minLength: 1, maxLength: 5 })
    .map((codes) =>
      codes.filter((c) => c.trim().toLowerCase().length > 0 && !catalogCodeSet.has(c.trim().toLowerCase()))
    )
    .filter((codes) => codes.length > 0);

  return fc.tuple(fc.constant(catalog), arbExtraCodes).map(([cat, extraCodes]) => {
    const filterableAttributes: Record<string, string[]> = {};
    for (const code of extraCodes) {
      filterableAttributes[code] = ["someValue"];
    }
    return { catalog: cat, filterableAttributes };
  });
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 13: Denormalization correctness", () => {
  const COMPANY_ID = "company1";
  const ACCOUNT_ID = "account1";

  it("filterableAttributeLabels SHALL contain exactly the codes present in filterableAttributes that also exist in the catalog", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDenormalizationScenario,
        async ({ catalog, filterableAttributes }) => {
          const catalogDocs: CatalogEntry[] = catalog.map((c) => ({
            ...c,
            companyId: COMPANY_ID,
            accountId: ACCOUNT_ID,
          }));

          const db = createMockDb(catalogDocs);

          const labels = await denormalizeFilterableAttributeLabels(
            db,
            COMPANY_ID,
            ACCOUNT_ID,
            filterableAttributes
          );

          // Compute expected: intersection of filterableAttributes keys and catalog codes
          const catalogCodeSet = new Set(
            catalog.map((c) => c.code.trim().toLowerCase())
          );

          // Only codes that are both in filterableAttributes AND in the catalog
          // AND whose catalog label is non-empty (implementation uses falsy check)
          const catalogLabelMap = new Map(
            catalog.map((c) => [c.code.trim().toLowerCase(), c.label.trim()])
          );

          const expectedCodes = Object.keys(filterableAttributes)
            .map((k) => k.trim().toLowerCase())
            .filter((code) => {
              const label = catalogLabelMap.get(code);
              return label !== undefined && label !== "";
            });

          // Labels keys SHALL be exactly the intersection (deduplicated)
          const labelKeys = Object.keys(labels).sort();
          const expectedKeys = [...new Set(expectedCodes)].sort();
          expect(labelKeys).toEqual(expectedKeys);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("codes not found in the catalog SHALL be omitted from filterableAttributeLabels", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNonCatalogOnlyScenario,
        async ({ catalog, filterableAttributes }) => {
          const catalogDocs: CatalogEntry[] = catalog.map((c) => ({
            ...c,
            companyId: COMPANY_ID,
            accountId: ACCOUNT_ID,
          }));

          const db = createMockDb(catalogDocs);

          const labels = await denormalizeFilterableAttributeLabels(
            db,
            COMPANY_ID,
            ACCOUNT_ID,
            filterableAttributes
          );

          // ALL codes are not in catalog → labels MUST be empty
          expect(labels).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });

  it("each included code's label SHALL match the catalog's current label value", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCatalog,
        async (catalog) => {
          const catalogDocs: CatalogEntry[] = catalog.map((c) => ({
            ...c,
            companyId: COMPANY_ID,
            accountId: ACCOUNT_ID,
          }));

          const db = createMockDb(catalogDocs);

          // Build filterableAttributes using ALL catalog codes
          const filterableAttributes: Record<string, string[]> = {};
          for (const entry of catalog) {
            filterableAttributes[entry.code] = ["someValue"];
          }

          const labels = await denormalizeFilterableAttributeLabels(
            db,
            COMPANY_ID,
            ACCOUNT_ID,
            filterableAttributes
          );

          // Each label in the result MUST match the catalog's label
          for (const entry of catalog) {
            const normalizedCode = entry.code.trim().toLowerCase();
            const expectedLabel = entry.label.trim();
            if (expectedLabel) {
              // Code exists in catalog with non-empty label → must be in result
              expect(labels[normalizedCode]).toBe(expectedLabel);
            } else {
              // Empty label → code is omitted (falsy check in implementation)
              expect(labels[normalizedCode]).toBeUndefined();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("empty filterableAttributes SHALL produce empty filterableAttributeLabels", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCatalog,
        async (catalog) => {
          const catalogDocs: CatalogEntry[] = catalog.map((c) => ({
            ...c,
            companyId: COMPANY_ID,
            accountId: ACCOUNT_ID,
          }));

          const db = createMockDb(catalogDocs);

          const labels = await denormalizeFilterableAttributeLabels(
            db,
            COMPANY_ID,
            ACCOUNT_ID,
            {}
          );

          expect(labels).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Feature: filterable-product-attributes, Property 9: Product_Mapper labels with fallback
 *
 * **Validates: Requirements 3.2, 3.4, 3.5**
 *
 * For any product in the Integration API response, `filterable_attribute_labels` SHALL
 * contain exactly the codes present in `filterable_attributes`. For each code, the label
 * SHALL be the value from the product's `filterableAttributeLabels` field if present and
 * non-empty, otherwise the code itself.
 *
 * Tag: Feature: filterable-product-attributes, Property 9: Product_Mapper labels with fallback
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  normalizeFilterableAttributes,
  normalizeFilterableAttributeLabels,
} from "../integration/mappers/product.mapper.js";

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid attribute code: lowercase alphanumeric with underscores/hyphens, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Non-empty value string (used as attribute values) */
const arbValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => {
    const trimmed = s.trim();
    return trimmed || "val";
  });

/** Non-empty label string, 1-50 chars */
const arbLabel = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => {
    const trimmed = s.trim();
    return trimmed || "Label";
  });

/**
 * Generates a product data object with filterableAttributes (valid map with non-empty arrays)
 * and filterableAttributeLabels (partial — some codes have labels, some don't).
 */
const arbProductWithPartialLabels = fc
  .uniqueArray(arbValidCode, { minLength: 1, maxLength: 8 })
  .chain((codes) => {
    // Generate values for each code (non-empty arrays)
    const arbValues = fc.tuple(
      ...codes.map(() => fc.array(arbValue, { minLength: 1, maxLength: 5 }))
    );

    // For each code, decide whether to include a label, leave it empty, or omit it
    const arbLabelDecisions = fc.tuple(
      ...codes.map(() =>
        fc.oneof(
          arbLabel.map((l) => ({ type: "present" as const, label: l })),
          fc.constant({ type: "empty" as const, label: "" }),
          fc.constant({ type: "whitespace" as const, label: "   " }),
          fc.constant({ type: "missing" as const, label: undefined })
        )
      )
    );

    return fc.tuple(fc.constant(codes), arbValues, arbLabelDecisions);
  })
  .map(([codes, valuesArr, labelDecisions]) => {
    const filterableAttributes: Record<string, string[]> = {};
    const filterableAttributeLabels: Record<string, unknown> = {};

    for (let i = 0; i < codes.length; i++) {
      filterableAttributes[codes[i]] = valuesArr[i];
      const decision = labelDecisions[i];
      if (decision.type === "present") {
        filterableAttributeLabels[codes[i]] = decision.label;
      } else if (decision.type === "empty") {
        filterableAttributeLabels[codes[i]] = "";
      } else if (decision.type === "whitespace") {
        filterableAttributeLabels[codes[i]] = "   ";
      }
      // "missing" → don't add to labels map
    }

    return {
      codes,
      filterableAttributes,
      filterableAttributeLabels,
      labelDecisions,
    };
  });

/**
 * Generates a product data object where filterableAttributeLabels is entirely absent/invalid.
 */
const arbProductWithNoLabelsField = fc
  .uniqueArray(arbValidCode, { minLength: 1, maxLength: 5 })
  .chain((codes) => {
    const arbValues = fc.tuple(
      ...codes.map(() => fc.array(arbValue, { minLength: 1, maxLength: 3 }))
    );
    const arbInvalidLabels = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant([]),
      fc.constant("not-an-object")
    );
    return fc.tuple(fc.constant(codes), arbValues, arbInvalidLabels);
  })
  .map(([codes, valuesArr, invalidLabels]) => {
    const filterableAttributes: Record<string, string[]> = {};
    for (let i = 0; i < codes.length; i++) {
      filterableAttributes[codes[i]] = valuesArr[i];
    }
    return { codes, filterableAttributes, invalidLabels };
  });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 9: Product_Mapper labels with fallback", () => {
  it("filterable_attribute_labels SHALL contain exactly the codes present in filterable_attributes", () => {
    fc.assert(
      fc.property(
        arbProductWithPartialLabels,
        ({ filterableAttributes, filterableAttributeLabels }) => {
          const data: Record<string, unknown> = {
            filterableAttributes,
            filterableAttributeLabels,
          };

          // First normalize the attributes (as the mapper pipeline does)
          const normalizedAttrs = normalizeFilterableAttributes(data);
          // Then normalize labels based on the normalized attributes
          const labels = normalizeFilterableAttributeLabels(data, normalizedAttrs);

          // Labels keys SHALL be exactly the same as normalizedAttrs keys
          const labelKeys = Object.keys(labels).sort();
          const attrKeys = Object.keys(normalizedAttrs).sort();
          expect(labelKeys).toEqual(attrKeys);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("for each code, the label SHALL be the value from filterableAttributeLabels if present and non-empty, otherwise the code itself", () => {
    fc.assert(
      fc.property(
        arbProductWithPartialLabels,
        ({ codes, filterableAttributes, filterableAttributeLabels, labelDecisions }) => {
          const data: Record<string, unknown> = {
            filterableAttributes,
            filterableAttributeLabels,
          };

          const normalizedAttrs = normalizeFilterableAttributes(data);
          const labels = normalizeFilterableAttributeLabels(data, normalizedAttrs);

          for (let i = 0; i < codes.length; i++) {
            const code = codes[i].trim().toLowerCase();
            if (!normalizedAttrs[code]) continue; // code was filtered out

            const decision = labelDecisions[i];
            if (decision.type === "present" && decision.label.trim() !== "") {
              // Label is present and non-empty → use it (trimmed)
              expect(labels[code]).toBe(decision.label.trim());
            } else {
              // Label is missing, empty, or whitespace-only → fallback to code
              expect(labels[code]).toBe(code);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("when filterableAttributeLabels field is absent/invalid, all labels SHALL fallback to the code", () => {
    fc.assert(
      fc.property(
        arbProductWithNoLabelsField,
        ({ codes, filterableAttributes, invalidLabels }) => {
          const data: Record<string, unknown> = {
            filterableAttributes,
            filterableAttributeLabels: invalidLabels,
          };

          const normalizedAttrs = normalizeFilterableAttributes(data);
          const labels = normalizeFilterableAttributeLabels(data, normalizedAttrs);

          // All labels should fallback to the code itself
          for (const code of Object.keys(normalizedAttrs)) {
            expect(labels[code]).toBe(code);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("when filterable_attributes is empty, filterable_attribute_labels SHALL be empty", () => {
    fc.assert(
      fc.property(
        fc.record({
          filterableAttributeLabels: fc.oneof(
            fc.constant({ marca: "Marca", genero: "Género" }),
            fc.constant({}),
            fc.constant(undefined),
            fc.constant(null)
          ),
        }),
        (labelsField) => {
          const data: Record<string, unknown> = {
            filterableAttributes: {},
            ...labelsField,
          };

          const normalizedAttrs = normalizeFilterableAttributes(data);
          const labels = normalizeFilterableAttributeLabels(data, normalizedAttrs);

          expect(normalizedAttrs).toEqual({});
          expect(labels).toEqual({});
        }
      ),
      { numRuns: 100 }
    );
  });
});

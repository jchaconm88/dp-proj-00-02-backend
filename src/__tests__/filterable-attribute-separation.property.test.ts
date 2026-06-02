/**
 * Feature: filterable-product-attributes, Property 10: Separation of variation and filterable attributes
 *
 * **Validates: Requirements 3.7**
 *
 * For any product in the Integration API response, the `attribute_definitions` and
 * `attribute_labels` fields SHALL NOT contain any codes that appear in
 * `filterable_attributes`, and vice versa — `filterable_attributes` SHALL NOT
 * contain codes from `attribute_definitions`.
 *
 * The Product_Mapper produces `attribute_definitions` from the product's
 * `attributeDefinitions` field and `filterable_attributes` from the product's
 * `filterableAttributes` field. These source fields are managed separately by the
 * ERP, ensuring disjoint code sets. This property verifies that the mapper
 * preserves this separation in the output.
 *
 * Tag: Feature: filterable-product-attributes, Property 10: Separation of variation and filterable attributes
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { toProductResponse } from "../integration/mappers/product.mapper.js";

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid attribute code: lowercase alphanumeric with hyphens/underscores, 1-15 chars */
const arbCode = fc.stringMatching(/^[a-z0-9_-]{1,15}$/);

/** Non-empty value string */
const arbValue = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => {
    const trimmed = s.trim();
    return trimmed || "val";
  });

/** Non-empty label string */
const arbLabel = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => {
    const trimmed = s.trim();
    return trimmed || "Label";
  });

/**
 * Generates a product data record with disjoint variation and filterable attribute codes.
 * This reflects the real system invariant: the ERP manages variation and filterable
 * attributes separately, so their codes never overlap in the source data.
 */
const arbProductWithDisjointAttributes = fc
  .uniqueArray(arbCode, { minLength: 2, maxLength: 10 })
  .chain((allCodes) => {
    // Split codes into two disjoint sets
    const splitPoint = Math.max(1, Math.floor(allCodes.length / 2));
    const variationCodes = allCodes.slice(0, splitPoint);
    const filterableCodes = allCodes.slice(splitPoint);

    // Generate values for each variation code
    const arbVariationEntries = fc.tuple(
      ...variationCodes.map((code) =>
        fc.array(arbValue, { minLength: 1, maxLength: 4 }).map((values) => [code, values] as const)
      )
    );

    // Generate values for each filterable code
    const arbFilterableEntries = fc.tuple(
      ...filterableCodes.map((code) =>
        fc.array(arbValue, { minLength: 1, maxLength: 4 }).map((values) => [code, values] as const)
      )
    );

    // Generate labels for variation codes
    const arbVariationLabels = fc.tuple(
      ...variationCodes.map((code) =>
        arbLabel.map((label) => [code, label] as const)
      )
    );

    // Generate labels for filterable codes
    const arbFilterableLabels = fc.tuple(
      ...filterableCodes.map((code) =>
        arbLabel.map((label) => [code, label] as const)
      )
    );

    return fc
      .tuple(arbVariationEntries, arbFilterableEntries, arbVariationLabels, arbFilterableLabels)
      .map(([varEntries, filtEntries, varLabels, filtLabels]) => {
        const attributeDefinitions: Record<string, string[]> = {};
        for (const [code, values] of varEntries) {
          attributeDefinitions[code] = values;
        }

        const filterableAttributes: Record<string, string[]> = {};
        for (const [code, values] of filtEntries) {
          filterableAttributes[code] = values;
        }

        const variantAttributeLabels: Record<string, string> = {};
        for (const [code, label] of varLabels) {
          variantAttributeLabels[code] = label;
        }

        const filterableAttributeLabels: Record<string, string> = {};
        for (const [code, label] of filtLabels) {
          filterableAttributeLabels[code] = label;
        }

        return {
          sku: "TEST-SKU",
          name: "Test Product",
          attributeDefinitions,
          filterableAttributes,
          variantAttributeLabels,
          filterableAttributeLabels,
          ecommerceStatus: "active",
          woocommerceType: "variable",
          visibleInStore: true,
          salePrice: 100,
          imageUrls: [],
          tags: [],
          categoryPath: [],
        };
      });
  });

/**
 * Generates a product with ONLY variation attributes (no filterable).
 * Verifies that filterable_attributes output is empty.
 */
const arbProductVariationOnly = fc
  .uniqueArray(arbCode, { minLength: 1, maxLength: 5 })
  .chain((codes) => {
    const arbEntries = fc.tuple(
      ...codes.map((code) =>
        fc.array(arbValue, { minLength: 1, maxLength: 3 }).map((values) => [code, values] as const)
      )
    );
    const arbLabels = fc.tuple(
      ...codes.map((code) =>
        arbLabel.map((label) => [code, label] as const)
      )
    );

    return fc.tuple(arbEntries, arbLabels).map(([entries, labels]) => {
      const attributeDefinitions: Record<string, string[]> = {};
      for (const [code, values] of entries) {
        attributeDefinitions[code] = values;
      }
      const variantAttributeLabels: Record<string, string> = {};
      for (const [code, label] of labels) {
        variantAttributeLabels[code] = label;
      }

      return {
        sku: "TEST-SKU",
        name: "Test Product",
        attributeDefinitions,
        filterableAttributes: {},
        variantAttributeLabels,
        filterableAttributeLabels: {},
        ecommerceStatus: "active",
        woocommerceType: "variable",
        visibleInStore: true,
        salePrice: 100,
        imageUrls: [],
        tags: [],
        categoryPath: [],
      };
    });
  });

/**
 * Generates a product with ONLY filterable attributes (no variation).
 * Verifies that attribute_definitions output is empty.
 */
const arbProductFilterableOnly = fc
  .uniqueArray(arbCode, { minLength: 1, maxLength: 5 })
  .chain((codes) => {
    const arbEntries = fc.tuple(
      ...codes.map((code) =>
        fc.array(arbValue, { minLength: 1, maxLength: 3 }).map((values) => [code, values] as const)
      )
    );
    const arbLabels = fc.tuple(
      ...codes.map((code) =>
        arbLabel.map((label) => [code, label] as const)
      )
    );

    return fc.tuple(arbEntries, arbLabels).map(([entries, labels]) => {
      const filterableAttributes: Record<string, string[]> = {};
      for (const [code, values] of entries) {
        filterableAttributes[code] = values;
      }
      const filterableAttributeLabels: Record<string, string> = {};
      for (const [code, label] of labels) {
        filterableAttributeLabels[code] = label;
      }

      return {
        sku: "TEST-SKU",
        name: "Test Product",
        attributeDefinitions: {},
        filterableAttributes,
        variantAttributeLabels: {},
        filterableAttributeLabels,
        ecommerceStatus: "active",
        woocommerceType: "variable",
        visibleInStore: true,
        salePrice: 100,
        imageUrls: [],
        tags: [],
        categoryPath: [],
      };
    });
  });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 10: Separation of variation and filterable attributes", () => {
  it("attribute_definitions and filterable_attributes output codes SHALL be disjoint", async () => {
    await fc.assert(
      fc.asyncProperty(arbProductWithDisjointAttributes, async (productData) => {
        const response = await toProductResponse(productData as Record<string, unknown>, []);

        const definitionCodes = new Set(Object.keys(response.attribute_definitions));
        const filterableCodes = new Set(Object.keys(response.filterable_attributes));

        // No code should appear in both output fields
        for (const code of definitionCodes) {
          expect(filterableCodes.has(code)).toBe(false);
        }
        for (const code of filterableCodes) {
          expect(definitionCodes.has(code)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("attribute_labels and filterable_attribute_labels output codes SHALL be disjoint", async () => {
    await fc.assert(
      fc.asyncProperty(arbProductWithDisjointAttributes, async (productData) => {
        const response = await toProductResponse(productData as Record<string, unknown>, []);

        const attrLabelCodes = new Set(Object.keys(response.attribute_labels));
        const filterableLabelCodes = new Set(Object.keys(response.filterable_attribute_labels));

        // No code should appear in both label output fields
        for (const code of attrLabelCodes) {
          expect(filterableLabelCodes.has(code)).toBe(false);
        }
        for (const code of filterableLabelCodes) {
          expect(attrLabelCodes.has(code)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("variation-only products SHALL have empty filterable_attributes", async () => {
    await fc.assert(
      fc.asyncProperty(arbProductVariationOnly, async (productData) => {
        const response = await toProductResponse(productData as Record<string, unknown>, []);

        // filterable_attributes must be empty
        expect(Object.keys(response.filterable_attributes).length).toBe(0);
        expect(Object.keys(response.filterable_attribute_labels).length).toBe(0);

        // attribute_definitions should have content
        expect(Object.keys(response.attribute_definitions).length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it("filterable-only products SHALL have empty attribute_definitions", async () => {
    await fc.assert(
      fc.asyncProperty(arbProductFilterableOnly, async (productData) => {
        const response = await toProductResponse(productData as Record<string, unknown>, []);

        // attribute_definitions must be empty
        expect(Object.keys(response.attribute_definitions).length).toBe(0);
        expect(Object.keys(response.attribute_labels).length).toBe(0);

        // filterable_attributes should have content
        expect(Object.keys(response.filterable_attributes).length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});

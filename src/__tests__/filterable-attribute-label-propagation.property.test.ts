/**
 * Feature: filterable-product-attributes, Property 14: Label propagation to products
 *
 * **Validates: Requirements 8.3**
 *
 * For any update to a filterable attribute type's `label` field, ALL products in the
 * same company whose `filterableAttributes` contains that type's code SHALL have their
 * `filterableAttributeLabels` entry for that code updated to the new label value.
 *
 * Tag: Feature: filterable-product-attributes, Property 14: Label propagation to products
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// ─── Domain types ────────────────────────────────────────────────────────────

interface FilterableAttributeType {
  id: string;
  code: string;
  label: string;
  companyId: string;
}

interface Product {
  id: string;
  companyId: string;
  filterableAttributes: Record<string, string[]>;
  filterableAttributeLabels: Record<string, string>;
}

// ─── In-memory store simulating Firestore label propagation ──────────────────

/**
 * Simulates the label propagation logic from the PUT endpoint in inventory.router.ts.
 * When a type's label is updated, all products in the same company that reference
 * that type's code in filterableAttributes get their filterableAttributeLabels updated.
 */
class LabelPropagationStore {
  private types: FilterableAttributeType[] = [];
  private products: Product[] = [];
  private nextTypeId = 1;
  private nextProductId = 1;

  /** Creates a filterable attribute type */
  createType(code: string, label: string, companyId: string): string {
    const id = `fat_${this.nextTypeId++}`;
    this.types.push({ id, code: code.trim().toLowerCase(), label, companyId });
    return id;
  }

  /** Creates a product with filterable attributes and labels */
  createProduct(
    companyId: string,
    filterableAttributes: Record<string, string[]>,
    filterableAttributeLabels: Record<string, string>
  ): string {
    const id = `prod_${this.nextProductId++}`;
    this.products.push({
      id,
      companyId,
      filterableAttributes: { ...filterableAttributes },
      filterableAttributeLabels: { ...filterableAttributeLabels },
    });
    return id;
  }

  /**
   * Updates a type's label and propagates the change to all products
   * in the same company that reference the type's code.
   * Mirrors the logic in inventory.router.ts PUT /filterable-attribute-types/:id
   */
  updateTypeLabel(typeId: string, newLabel: string): void {
    const type = this.types.find((t) => t.id === typeId);
    if (!type) return;

    const oldLabel = type.label;
    type.label = newLabel;

    // Propagate to all products in the same company that have this code
    const typeCode = type.code;
    for (const product of this.products) {
      if (product.companyId !== type.companyId) continue;
      if (!Object.prototype.hasOwnProperty.call(product.filterableAttributes, typeCode)) continue;
      // Update the label entry for this code
      product.filterableAttributeLabels[typeCode] = newLabel;
    }
  }

  /** Gets a product by ID */
  getProduct(id: string): Product | undefined {
    return this.products.find((p) => p.id === id);
  }

  /** Gets all products in a company that reference a given code */
  getProductsByCode(companyId: string, code: string): Product[] {
    return this.products.filter(
      (p) => p.companyId === companyId && Object.prototype.hasOwnProperty.call(p.filterableAttributes, code)
    );
  }

  /** Gets a type by ID */
  getType(id: string): FilterableAttributeType | undefined {
    return this.types.find((t) => t.id === id);
  }
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Company ID generator: alphanumeric, 5-15 chars */
const arbCompanyId = fc.stringMatching(/^[a-z0-9]{5,15}$/);

/** Label generator: non-empty, 1-50 chars */
const arbLabel = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((s) => s.trim() || "Label")
  .filter((s) => s.length >= 1 && s.length <= 50);

/** Value string generator */
const arbValue = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/\s+/g, " ").trim() || "val")
  .filter((s) => s.length >= 1);

/** Generates a non-empty array of values */
const arbValues = fc.uniqueArray(arbValue, { minLength: 1, maxLength: 5, comparator: (a, b) => a === b });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 14: Label propagation to products", () => {
  it("ALL products referencing the type's code SHALL have their label updated", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbCompanyId,
        arbLabel,
        arbLabel,
        arbValues,
        fc.integer({ min: 1, max: 10 }),
        (code, companyId, originalLabel, newLabel, values, productCount) => {
          // Precondition: new label must differ from original
          fc.pre(newLabel !== originalLabel);

          const store = new LabelPropagationStore();

          // Create the type
          const typeId = store.createType(code, originalLabel, companyId);

          // Create multiple products that reference this type's code
          const productIds: string[] = [];
          for (let i = 0; i < productCount; i++) {
            const prodId = store.createProduct(
              companyId,
              { [code]: values },
              { [code]: originalLabel }
            );
            productIds.push(prodId);
          }

          // Verify initial state: all products have the original label
          for (const prodId of productIds) {
            const product = store.getProduct(prodId);
            expect(product?.filterableAttributeLabels[code]).toBe(originalLabel);
          }

          // Update the type's label
          store.updateTypeLabel(typeId, newLabel);

          // Verify: ALL products SHALL have the new label
          for (const prodId of productIds) {
            const product = store.getProduct(prodId);
            expect(product?.filterableAttributeLabels[code]).toBe(newLabel);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("products in a DIFFERENT company SHALL NOT be affected by the label update", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbCompanyId,
        arbCompanyId,
        arbLabel,
        arbLabel,
        arbValues,
        (code, companyA, companyB, originalLabel, newLabel, values) => {
          // Precondition: companies must differ, labels must differ
          fc.pre(companyA !== companyB);
          fc.pre(newLabel !== originalLabel);

          const store = new LabelPropagationStore();

          // Create type in company A
          const typeId = store.createType(code, originalLabel, companyA);

          // Create product in company A (should be affected)
          const prodA = store.createProduct(
            companyA,
            { [code]: values },
            { [code]: originalLabel }
          );

          // Create product in company B with same code (should NOT be affected)
          const prodB = store.createProduct(
            companyB,
            { [code]: values },
            { [code]: originalLabel }
          );

          // Update the type's label in company A
          store.updateTypeLabel(typeId, newLabel);

          // Company A product SHALL have the new label
          const productA = store.getProduct(prodA);
          expect(productA?.filterableAttributeLabels[code]).toBe(newLabel);

          // Company B product SHALL still have the original label
          const productB = store.getProduct(prodB);
          expect(productB?.filterableAttributeLabels[code]).toBe(originalLabel);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("products that do NOT reference the updated type's code SHALL NOT be affected", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbValidCode,
        arbCompanyId,
        arbLabel,
        arbLabel,
        arbValues,
        (codeA, codeB, companyId, originalLabel, newLabel, values) => {
          // Precondition: codes must differ, labels must differ
          fc.pre(codeA !== codeB);
          fc.pre(newLabel !== originalLabel);

          const store = new LabelPropagationStore();

          // Create type for codeA
          const typeId = store.createType(codeA, originalLabel, companyId);

          // Create product referencing codeA (should be affected)
          const prodWithCode = store.createProduct(
            companyId,
            { [codeA]: values },
            { [codeA]: originalLabel }
          );

          // Create product referencing codeB only (should NOT be affected)
          const prodWithoutCode = store.createProduct(
            companyId,
            { [codeB]: values },
            { [codeB]: "Other Label" }
          );

          // Update codeA's label
          store.updateTypeLabel(typeId, newLabel);

          // Product with codeA SHALL have the new label
          const productWith = store.getProduct(prodWithCode);
          expect(productWith?.filterableAttributeLabels[codeA]).toBe(newLabel);

          // Product with codeB SHALL NOT be affected
          const productWithout = store.getProduct(prodWithoutCode);
          expect(productWithout?.filterableAttributeLabels[codeB]).toBe("Other Label");
          // And it should NOT have codeA in its labels
          expect(productWithout?.filterableAttributeLabels[codeA]).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("other labels on the same product SHALL NOT be affected by the update", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbValidCode,
        arbCompanyId,
        arbLabel,
        arbLabel,
        arbLabel,
        arbValues,
        (codeA, codeB, companyId, labelA, newLabelA, labelB, values) => {
          // Precondition: codes must differ, labels must differ
          fc.pre(codeA !== codeB);
          fc.pre(newLabelA !== labelA);

          const store = new LabelPropagationStore();

          // Create types for both codes
          const typeIdA = store.createType(codeA, labelA, companyId);
          store.createType(codeB, labelB, companyId);

          // Create product referencing both codes
          const prodId = store.createProduct(
            companyId,
            { [codeA]: values, [codeB]: values },
            { [codeA]: labelA, [codeB]: labelB }
          );

          // Update only codeA's label
          store.updateTypeLabel(typeIdA, newLabelA);

          // codeA's label SHALL be updated
          const product = store.getProduct(prodId);
          expect(product?.filterableAttributeLabels[codeA]).toBe(newLabelA);

          // codeB's label SHALL remain unchanged
          expect(product?.filterableAttributeLabels[codeB]).toBe(labelB);
        }
      ),
      { numRuns: 100 }
    );
  });
});

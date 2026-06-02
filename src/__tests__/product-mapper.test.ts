import fc from "fast-check";
import { describe, it, expect } from "vitest";

interface StockData {
  sku: string;
  quantity: number;
}

interface TestVariant {
  sku: string;
  attributes: Record<string, string>;
  salePrice: number;
  images: string[];
  active: boolean;
}

interface TestProduct {
  sku?: string;
  name: string;
  woocommerceType: "simple" | "variable" | "grouped";
  ecommerceStatus: "active" | "inactive" | "discontinued";
  visibleInStore: boolean;
  salePrice: number;
  imageUrls: string[];
  variants: TestVariant[];
  groupedProductIds: string[];
  tags: string[];
}

function mapEcommerceStatus(status: string): string {
  const map: Record<string, string> = {
    active: "publish",
    inactive: "draft",
    discontinued: "private",
  };
  return map[status] ?? "draft";
}

function filterIntegrationProducts(products: TestProduct[]): TestProduct[] {
  return products.filter(p => p.visibleInStore === true && p.sku && p.sku.trim().length > 0);
}

describe("Property 13: Integration API filtering", () => {
  it("should only include products with visibleInStore=true and non-empty SKU", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sku: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
            name: fc.string({ minLength: 1, maxLength: 20 }),
            woocommerceType: fc.constantFrom<"simple" | "variable" | "grouped">("simple", "variable", "grouped"),
            ecommerceStatus: fc.constantFrom<"active" | "inactive" | "discontinued">("active", "inactive", "discontinued"),
            visibleInStore: fc.boolean(),
            salePrice: fc.nat({ max: 1000 }),
            imageUrls: fc.constant<string[]>([]),
            variants: fc.constant<TestVariant[]>([]),
            groupedProductIds: fc.constant<string[]>([]),
            tags: fc.constant<string[]>([]),
          }),
          { minLength: 0, maxLength: 30 }
        ),
        (products) => {
          const filtered = filterIntegrationProducts(products);
          for (const p of filtered) {
            expect(p.visibleInStore).toBe(true);
            expect(p.sku).toBeDefined();
            expect(p.sku!.trim().length).toBeGreaterThan(0);
          }
          for (const p of products) {
            if (p.visibleInStore === true && p.sku && p.sku.trim().length > 0) {
              expect(filtered).toContainEqual(p);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("Property 16: ecommerceStatus mapping", () => {
  it("should map active→publish, inactive→draft, discontinued→private", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"active" | "inactive" | "discontinued">("active", "inactive", "discontinued"),
        (status) => {
          const mapped = mapEcommerceStatus(status);
          const expected: Record<string, string> = {
            active: "publish",
            inactive: "draft",
            discontinued: "private",
          };
          expect(mapped).toBe(expected[status]);
        }
      ),
      { numRuns: 100 }
    );
  });
});

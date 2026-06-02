/**
 * Integration Tests: End-to-end flows for filterable product attributes
 *
 * Tests the interaction between:
 * 1. Catalog CRUD → Product assignment → Integration API response
 * 2. Label update propagation
 * 3. Delete protection (409 when type is assigned)
 * 4. Sync_Plugin taxonomy compatibility (simulated via TypeScript)
 *
 * _Requirements: 7.5, 8.3, 5.1_
 */

import { describe, it, expect } from "vitest";
import {
  normalizeFilterableAttributes,
  normalizeFilterableAttributeLabels,
} from "../integration/mappers/product.mapper.js";
import {
  parseFilterableAttributes,
  denormalizeFilterableAttributeLabels,
} from "../web/filterable-attribute-types.helpers.js";

// ─── Mock Firestore helpers ──────────────────────────────────────────────────

interface MockDoc {
  id: string;
  data: Record<string, unknown>;
}

interface MockCollection {
  docs: MockDoc[];
}

/**
 * Creates a mock Firestore DB that simulates the filterable-attribute-types
 * and products collections for integration testing.
 */
function createMockFirestore(
  attributeTypes: Array<{ id: string; code: string; label: string; values: string[]; sortOrder: number; active: boolean; companyId: string; accountId: string }>,
  products: Array<{ id: string; companyId: string; accountId: string; filterableAttributes: Record<string, string[]>; filterableAttributeLabels: Record<string, string> }>
) {
  const collections: Record<string, MockDoc[]> = {
    "filterable-attribute-types": attributeTypes.map((t) => ({
      id: t.id,
      data: { ...t },
    })),
    products: products.map((p) => ({
      id: p.id,
      data: { ...p },
    })),
  };

  return {
    collection: (name: string) => ({
      where: (field: string, _op: string, value: unknown) => {
        const filters: Array<{ field: string; value: unknown }> = [{ field, value }];
        const chainable: any = {
          where: (f: string, _o: string, v: unknown) => {
            filters.push({ field: f, value: v });
            return chainable;
          },
          limit: (_n: number) => chainable,
          get: async () => {
            let docs = collections[name] || [];
            for (const filter of filters) {
              docs = docs.filter((d) => {
                const fieldPath = filter.field;
                // Support nested field paths like "filterableAttributes.marca"
                const parts = fieldPath.split(".");
                let val: any = d.data;
                for (const part of parts) {
                  val = val?.[part];
                }
                if (_op === "!=" || filters.find(f => f.field === fieldPath)?.value !== undefined) {
                  // For != null checks, just verify the field exists and is not null
                  if (filter.value === null) return val != null;
                }
                return val === filter.value;
              });
            }
            return {
              empty: docs.length === 0,
              size: docs.length,
              docs: docs.map((d) => ({
                id: d.id,
                ref: { id: d.id },
                exists: true,
                data: () => d.data,
              })),
            };
          },
        };
        return chainable;
      },
    }),
  } as unknown as FirebaseFirestore.Firestore;
}

// ─── Sync_Plugin simulation helpers ──────────────────────────────────────────

const MAX_TAXONOMY_SLUG_LENGTH = 28;

/**
 * Simulates WooCommerce's `wc_sanitize_taxonomy_name()` behavior.
 */
function wcSanitizeTaxonomyName(label: string): string {
  let slug = label.toLowerCase();
  slug = slug.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  slug = slug.replace(/[^a-z0-9]/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  return slug;
}

/**
 * Derives the taxonomy slug for a filterable attribute, with truncation.
 */
function deriveFilterableAttributeSlug(label: string): string {
  const rawSlug = wcSanitizeTaxonomyName(label);
  return rawSlug.length > MAX_TAXONOMY_SLUG_LENGTH
    ? rawSlug.substring(0, MAX_TAXONOMY_SLUG_LENGTH)
    : rawSlug;
}

/**
 * Simulates the Sync_Plugin's taxonomy resolution logic.
 * Given existing taxonomies and a filterable attribute label, determines
 * whether to reuse an existing taxonomy or create a new one.
 */
function resolveTaxonomy(
  label: string,
  existingTaxonomies: Map<string, { name: string; slug: string; has_archives: boolean }>
): { action: "reuse" | "create"; taxonomy: string; slug: string } {
  const slug = deriveFilterableAttributeSlug(label);
  const taxonomy = `pa_${slug}`;

  if (existingTaxonomies.has(slug)) {
    return { action: "reuse", taxonomy, slug };
  }
  return { action: "create", taxonomy, slug };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Crear tipo → asignar a producto → verificar en Integration API response
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: crear tipo → asignar a producto → verificar en Integration API", () => {
  it("full flow: type creation, product assignment, and API response mapping", async () => {
    // Step 1: Simulate creating a filterable attribute type in the catalog
    const attributeType = {
      id: "fat-001",
      code: "marca",
      label: "Marca",
      values: ["Nike", "Adidas", "Puma"],
      sortOrder: 1,
      active: true,
      companyId: "company-1",
      accountId: "account-1",
    };

    // Step 2: Simulate assigning the attribute to a product
    const productFilterableAttributes = { marca: ["Nike"] };

    // Step 3: Denormalize labels (as the backend does on product save)
    const db = createMockFirestore([attributeType], []);
    const labels = await denormalizeFilterableAttributeLabels(
      db,
      "company-1",
      "account-1",
      productFilterableAttributes
    );

    expect(labels).toEqual({ marca: "Marca" });

    // Step 4: Simulate the product record as stored in Firestore
    const productRecord: Record<string, unknown> = {
      sku: "PROD-001",
      name: "Zapatilla Running",
      filterableAttributes: productFilterableAttributes,
      filterableAttributeLabels: labels,
    };

    // Step 5: Verify Integration API response via Product_Mapper
    const filterable_attributes = normalizeFilterableAttributes(productRecord);
    const filterable_attribute_labels = normalizeFilterableAttributeLabels(
      productRecord,
      filterable_attributes
    );

    expect(filterable_attributes).toEqual({ marca: ["Nike"] });
    expect(filterable_attribute_labels).toEqual({ marca: "Marca" });
  });

  it("multiple attribute types assigned to a product appear correctly in API response", async () => {
    const attributeTypes = [
      { id: "fat-001", code: "marca", label: "Marca", values: ["Nike", "Adidas"], sortOrder: 1, active: true, companyId: "c1", accountId: "a1" },
      { id: "fat-002", code: "genero", label: "Género", values: ["Hombre", "Mujer"], sortOrder: 2, active: true, companyId: "c1", accountId: "a1" },
      { id: "fat-003", code: "material", label: "Material", values: ["Cuero", "Textil", "Sintético"], sortOrder: 3, active: true, companyId: "c1", accountId: "a1" },
    ];

    const productFilterableAttributes = {
      marca: ["Nike"],
      genero: ["Hombre"],
      material: ["Cuero", "Textil"],
    };

    // Denormalize labels
    const db = createMockFirestore(attributeTypes, []);
    const labels = await denormalizeFilterableAttributeLabels(db, "c1", "a1", productFilterableAttributes);

    expect(labels).toEqual({
      marca: "Marca",
      genero: "Género",
      material: "Material",
    });

    // Simulate product record
    const productRecord: Record<string, unknown> = {
      filterableAttributes: productFilterableAttributes,
      filterableAttributeLabels: labels,
    };

    // Verify API response
    const filterable_attributes = normalizeFilterableAttributes(productRecord);
    const filterable_attribute_labels = normalizeFilterableAttributeLabels(productRecord, filterable_attributes);

    expect(filterable_attributes).toEqual({
      marca: ["Nike"],
      genero: ["Hombre"],
      material: ["Cuero", "Textil"],
    });
    expect(filterable_attribute_labels).toEqual({
      marca: "Marca",
      genero: "Género",
      material: "Material",
    });
  });

  it("product with no filterable attributes returns empty objects in API response", async () => {
    const db = createMockFirestore([], []);
    const labels = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {});

    expect(labels).toEqual({});

    const productRecord: Record<string, unknown> = {
      filterableAttributes: {},
      filterableAttributeLabels: {},
    };

    const filterable_attributes = normalizeFilterableAttributes(productRecord);
    const filterable_attribute_labels = normalizeFilterableAttributeLabels(productRecord, filterable_attributes);

    expect(filterable_attributes).toEqual({});
    expect(filterable_attribute_labels).toEqual({});
  });

  it("codes not in catalog are omitted from labels but values still appear in API", async () => {
    // Only "marca" exists in catalog, but product has "marca" and "estilo"
    const attributeTypes = [
      { id: "fat-001", code: "marca", label: "Marca", values: ["Nike"], sortOrder: 1, active: true, companyId: "c1", accountId: "a1" },
    ];

    const productFilterableAttributes = {
      marca: ["Nike"],
      estilo: ["Casual"],
    };

    const db = createMockFirestore(attributeTypes, []);
    const labels = await denormalizeFilterableAttributeLabels(db, "c1", "a1", productFilterableAttributes);

    // "estilo" is omitted from labels because it's not in catalog
    expect(labels).toEqual({ marca: "Marca" });

    // But in the API response, both codes appear in filterable_attributes
    const productRecord: Record<string, unknown> = {
      filterableAttributes: productFilterableAttributes,
      filterableAttributeLabels: labels,
    };

    const filterable_attributes = normalizeFilterableAttributes(productRecord);
    const filterable_attribute_labels = normalizeFilterableAttributeLabels(productRecord, filterable_attributes);

    expect(filterable_attributes).toEqual({ marca: ["Nike"], estilo: ["Casual"] });
    // "estilo" falls back to code as label since it's not in filterableAttributeLabels
    expect(filterable_attribute_labels).toEqual({ marca: "Marca", estilo: "estilo" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Actualizar label de tipo → verificar propagación a productos
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: actualizar label de tipo → verificar propagación a productos", () => {
  it("label update propagates to all products referencing the type", async () => {
    // Initial state: type with label "Marca", products referencing it
    const attributeType = {
      id: "fat-001",
      code: "marca",
      label: "Marca",
      values: ["Nike", "Adidas"],
      sortOrder: 1,
      active: true,
      companyId: "c1",
      accountId: "a1",
    };

    // Simulate 3 products with the "marca" attribute
    const products = [
      { id: "p1", companyId: "c1", accountId: "a1", filterableAttributes: { marca: ["Nike"] }, filterableAttributeLabels: { marca: "Marca" } },
      { id: "p2", companyId: "c1", accountId: "a1", filterableAttributes: { marca: ["Adidas"] }, filterableAttributeLabels: { marca: "Marca" } },
      { id: "p3", companyId: "c1", accountId: "a1", filterableAttributes: { marca: ["Nike"], genero: ["Hombre"] }, filterableAttributeLabels: { marca: "Marca", genero: "Género" } },
    ];

    // Simulate the label update: "Marca" → "Brand"
    const newLabel = "Brand";

    // Propagation logic: update filterableAttributeLabels for all products
    // that have "marca" in their filterableAttributes
    const updatedProducts = products.map((p) => {
      if ("marca" in p.filterableAttributes) {
        return {
          ...p,
          filterableAttributeLabels: {
            ...p.filterableAttributeLabels,
            marca: newLabel,
          },
        };
      }
      return p;
    });

    // Verify all products now have the new label
    for (const product of updatedProducts) {
      expect(product.filterableAttributeLabels.marca).toBe("Brand");
    }

    // Verify the API response reflects the new label
    for (const product of updatedProducts) {
      const productRecord: Record<string, unknown> = {
        filterableAttributes: product.filterableAttributes,
        filterableAttributeLabels: product.filterableAttributeLabels,
      };
      const fa = normalizeFilterableAttributes(productRecord);
      const fal = normalizeFilterableAttributeLabels(productRecord, fa);

      expect(fal.marca).toBe("Brand");
    }

    // Verify product p3's other labels are unaffected
    const p3 = updatedProducts[2];
    expect(p3.filterableAttributeLabels.genero).toBe("Género");
  });

  it("label update does NOT affect products in a different company", () => {
    const productsCompanyA = [
      { id: "p1", companyId: "c1", filterableAttributes: { marca: ["Nike"] }, filterableAttributeLabels: { marca: "Marca" } },
    ];
    const productsCompanyB = [
      { id: "p2", companyId: "c2", filterableAttributes: { marca: ["Adidas"] }, filterableAttributeLabels: { marca: "Marca" } },
    ];

    const typeCompanyId = "c1";
    const typeCode = "marca";
    const newLabel = "Brand";

    // Propagation only affects products in the same company
    const allProducts = [...productsCompanyA, ...productsCompanyB];
    const updatedProducts = allProducts.map((p) => {
      if (p.companyId === typeCompanyId && typeCode in p.filterableAttributes) {
        return {
          ...p,
          filterableAttributeLabels: { ...p.filterableAttributeLabels, [typeCode]: newLabel },
        };
      }
      return p;
    });

    // Company A product updated
    expect(updatedProducts[0].filterableAttributeLabels.marca).toBe("Brand");
    // Company B product unchanged
    expect(updatedProducts[1].filterableAttributeLabels.marca).toBe("Marca");
  });

  it("label update with denormalization re-resolves correctly from catalog", async () => {
    // After label update, re-denormalizing from the updated catalog should match
    const updatedType = {
      id: "fat-001",
      code: "marca",
      label: "Brand",  // Updated label
      values: ["Nike", "Adidas"],
      sortOrder: 1,
      active: true,
      companyId: "c1",
      accountId: "a1",
    };

    const db = createMockFirestore([updatedType], []);
    const labels = await denormalizeFilterableAttributeLabels(
      db, "c1", "a1", { marca: ["Nike"] }
    );

    expect(labels).toEqual({ marca: "Brand" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Eliminar tipo asignado → verificar rechazo 409
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: eliminar tipo asignado → verificar rechazo 409", () => {
  /**
   * Simulates the DELETE endpoint's protection logic:
   * If the type's code is referenced by any product's filterableAttributes,
   * the deletion is rejected with 409.
   */
  function simulateDeleteProtection(
    typeCode: string,
    companyId: string,
    products: Array<{ companyId: string; filterableAttributes: Record<string, string[]> }>
  ): { allowed: boolean; status: number; error?: string; count?: number } {
    const productsUsingType = products.filter(
      (p) => p.companyId === companyId && typeCode in p.filterableAttributes
    );

    if (productsUsingType.length > 0) {
      return {
        allowed: false,
        status: 409,
        error: "type_in_use",
        count: productsUsingType.length,
      };
    }

    return { allowed: true, status: 200 };
  }

  it("rejects deletion with 409 when type is assigned to a product", () => {
    const products: Array<{ companyId: string; filterableAttributes: Record<string, string[]> }> = [
      { companyId: "c1", filterableAttributes: { marca: ["Nike"] } },
      { companyId: "c1", filterableAttributes: { marca: ["Adidas"], genero: ["Hombre"] } },
    ];

    const result = simulateDeleteProtection("marca", "c1", products);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toBe("type_in_use");
    expect(result.count).toBe(2);
  });

  it("allows deletion when type is NOT assigned to any product", () => {
    const products: Array<{ companyId: string; filterableAttributes: Record<string, string[]> }> = [
      { companyId: "c1", filterableAttributes: { genero: ["Hombre"] } },
      { companyId: "c1", filterableAttributes: { material: ["Cuero"] } },
    ];

    const result = simulateDeleteProtection("marca", "c1", products);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe(200);
  });

  it("allows deletion when type is assigned only in a different company", () => {
    const products = [
      { companyId: "c2", filterableAttributes: { marca: ["Nike"] } },
    ];

    const result = simulateDeleteProtection("marca", "c1", products);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe(200);
  });

  it("rejects deletion even when only one product uses the type", () => {
    const products: Array<{ companyId: string; filterableAttributes: Record<string, string[]> }> = [
      { companyId: "c1", filterableAttributes: { marca: ["Nike"] } },
      { companyId: "c1", filterableAttributes: { genero: ["Mujer"] } },
    ];

    const result = simulateDeleteProtection("marca", "c1", products);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe(409);
    expect(result.count).toBe(1);
  });

  it("error message includes the count of products using the type", () => {
    const products = [
      { companyId: "c1", filterableAttributes: { marca: ["Nike"] } },
      { companyId: "c1", filterableAttributes: { marca: ["Adidas"] } },
      { companyId: "c1", filterableAttributes: { marca: ["Puma"] } },
    ];

    const result = simulateDeleteProtection("marca", "c1", products);

    expect(result.allowed).toBe(false);
    expect(result.count).toBe(3);
    // The actual endpoint returns: "Cannot delete: type is assigned to 3 product(s)"
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: Sync con taxonomías existentes del tema
// ═══════════════════════════════════════════════════════════════════════════════

describe("Integration: sync con taxonomías existentes del tema", () => {
  // Simulate the theme's existing taxonomies (as registered in wc_attribute_taxonomies)
  const themeTaxonomies = new Map<string, { name: string; slug: string; has_archives: boolean }>([
    ["tipo", { name: "Tipo", slug: "tipo", has_archives: true }],
    ["talla", { name: "Talla", slug: "talla", has_archives: false }],
    ["genero", { name: "Género", slug: "genero", has_archives: true }],
    ["color", { name: "Color", slug: "color", has_archives: false }],
    ["marca", { name: "Marca", slug: "marca", has_archives: true }],
  ]);

  it("reuses existing pa_marca taxonomy when label is 'Marca'", () => {
    const result = resolveTaxonomy("Marca", themeTaxonomies);

    expect(result.action).toBe("reuse");
    expect(result.taxonomy).toBe("pa_marca");
    expect(result.slug).toBe("marca");
  });

  it("reuses existing pa_genero taxonomy when label is 'Género' (diacritics removed)", () => {
    const result = resolveTaxonomy("Género", themeTaxonomies);

    expect(result.action).toBe("reuse");
    expect(result.taxonomy).toBe("pa_genero");
    expect(result.slug).toBe("genero");
  });

  it("reuses existing pa_tipo taxonomy when label is 'Tipo'", () => {
    const result = resolveTaxonomy("Tipo", themeTaxonomies);

    expect(result.action).toBe("reuse");
    expect(result.taxonomy).toBe("pa_tipo");
    expect(result.slug).toBe("tipo");
  });

  it("creates new taxonomy when label does not match any existing taxonomy", () => {
    const result = resolveTaxonomy("Estilo", themeTaxonomies);

    expect(result.action).toBe("create");
    expect(result.taxonomy).toBe("pa_estilo");
    expect(result.slug).toBe("estilo");
  });

  it("full sync flow: ERP attributes resolve to correct theme taxonomies", () => {
    // Simulate a product from the Integration API with filterable attributes
    const apiResponse = {
      filterable_attributes: {
        marca: ["Nike"],
        genero: ["Hombre"],
        material: ["Cuero", "Textil"],
      },
      filterable_attribute_labels: {
        marca: "Marca",
        genero: "Género",
        material: "Material",
      },
    };

    // For each filterable attribute, resolve the taxonomy
    const results: Array<{ code: string; action: string; taxonomy: string }> = [];
    for (const [code, values] of Object.entries(apiResponse.filterable_attributes)) {
      const label = (apiResponse.filterable_attribute_labels as Record<string, string>)[code] || code;
      const resolution = resolveTaxonomy(label, themeTaxonomies);
      results.push({ code, action: resolution.action, taxonomy: resolution.taxonomy });
    }

    // "marca" and "genero" should reuse existing theme taxonomies
    expect(results.find((r) => r.code === "marca")).toEqual({
      code: "marca",
      action: "reuse",
      taxonomy: "pa_marca",
    });
    expect(results.find((r) => r.code === "genero")).toEqual({
      code: "genero",
      action: "reuse",
      taxonomy: "pa_genero",
    });
    // "material" is not in the theme, so it should create a new taxonomy
    expect(results.find((r) => r.code === "material")).toEqual({
      code: "material",
      action: "create",
      taxonomy: "pa_material",
    });
  });

  it("slug derivation handles long labels with truncation to 28 chars", () => {
    const longLabel = "Características Técnicas del Producto";
    const slug = deriveFilterableAttributeSlug(longLabel);

    expect(slug.length).toBeLessThanOrEqual(MAX_TAXONOMY_SLUG_LENGTH);
    // The slug should be a valid taxonomy name (only a-z, 0-9, hyphens)
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("end-to-end: type creation → API exposure → taxonomy resolution matches theme", async () => {
    // Step 1: Create type in catalog
    const attributeType = {
      id: "fat-marca",
      code: "marca",
      label: "Marca",
      values: ["Nike", "Adidas", "Puma"],
      sortOrder: 1,
      active: true,
      companyId: "c1",
      accountId: "a1",
    };

    // Step 2: Assign to product and denormalize
    const productAttrs = { marca: ["Nike", "Adidas"] };
    const db = createMockFirestore([attributeType], []);
    const labels = await denormalizeFilterableAttributeLabels(db, "c1", "a1", productAttrs);

    // Step 3: Product_Mapper produces API response
    const productRecord: Record<string, unknown> = {
      filterableAttributes: productAttrs,
      filterableAttributeLabels: labels,
    };
    const fa = normalizeFilterableAttributes(productRecord);
    const fal = normalizeFilterableAttributeLabels(productRecord, fa);

    // Step 4: Sync_Plugin resolves taxonomy from API response
    const taxonomyResolution = resolveTaxonomy(fal.marca, themeTaxonomies);

    // Verify the full chain
    expect(fa).toEqual({ marca: ["Nike", "Adidas"] });
    expect(fal).toEqual({ marca: "Marca" });
    expect(taxonomyResolution.action).toBe("reuse");
    expect(taxonomyResolution.taxonomy).toBe("pa_marca");
  });

  it("taxonomy previously created by sync is reused without modification", () => {
    // Simulate a taxonomy that was created by a previous sync (not by the theme)
    const existingTaxonomies = new Map<string, { name: string; slug: string; has_archives: boolean }>([
      ...themeTaxonomies,
      ["estilo", { name: "Estilo", slug: "estilo", has_archives: true }],
    ]);

    const result = resolveTaxonomy("Estilo", existingTaxonomies);

    // Should reuse the existing taxonomy (Requirement 5.8)
    expect(result.action).toBe("reuse");
    expect(result.taxonomy).toBe("pa_estilo");
  });
});

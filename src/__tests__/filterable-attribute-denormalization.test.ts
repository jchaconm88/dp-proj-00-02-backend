import { describe, it, expect } from "vitest";
import {
  parseFilterableAttributes,
  denormalizeFilterableAttributeLabels,
} from "../web/filterable-attribute-types.helpers.js";

// ─── Unit Tests for parseFilterableAttributes ────────────────────────────────

describe("parseFilterableAttributes", () => {
  it("returns {} for null/undefined/non-object input", () => {
    expect(parseFilterableAttributes(null)).toEqual({});
    expect(parseFilterableAttributes(undefined)).toEqual({});
    expect(parseFilterableAttributes("string")).toEqual({});
    expect(parseFilterableAttributes(123)).toEqual({});
    expect(parseFilterableAttributes([])).toEqual({});
  });

  it("parses a valid filterableAttributes map", () => {
    const input = {
      marca: ["Nike", "Adidas"],
      material: ["Cuero"],
    };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike", "Adidas"],
      material: ["Cuero"],
    });
  });

  it("normalizes codes to lowercase", () => {
    const input = { MARCA: ["Nike"], Material: ["Cuero"] };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike"],
      material: ["Cuero"],
    });
  });

  it("trims code keys and values", () => {
    const input = { "  marca  ": ["  Nike  ", "Adidas"] };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike", "Adidas"],
    });
  });

  it("omits entries with empty arrays", () => {
    const input = { marca: ["Nike"], material: [] };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike"],
    });
  });

  it("omits entries with non-array values", () => {
    const input = { marca: ["Nike"], material: "Cuero", genero: 123 };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike"],
    });
  });

  it("filters out empty string values from arrays", () => {
    const input = { marca: ["Nike", "", "  ", "Adidas"] };
    expect(parseFilterableAttributes(input)).toEqual({
      marca: ["Nike", "Adidas"],
    });
  });

  it("returns {} for empty object", () => {
    expect(parseFilterableAttributes({})).toEqual({});
  });
});

// ─── Unit Tests for denormalizeFilterableAttributeLabels ──────────────────────

describe("denormalizeFilterableAttributeLabels", () => {
  // Mock Firestore for testing
  function createMockDb(catalogDocs: Array<{ code: string; label: string; companyId: string; accountId: string }>) {
    return {
      collection: (_name: string) => ({
        where: (field: string, _op: string, value: string) => {
          // Chain where calls - track filters
          const filters: Record<string, string> = { [field]: value };
          const chainable = {
            where: (f2: string, _op2: string, v2: string) => {
              filters[f2] = v2;
              return chainable;
            },
            get: async () => {
              const matchingDocs = catalogDocs
                .filter((d) => d.companyId === filters["companyId"] && d.accountId === filters["accountId"])
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

  it("returns {} when filterableAttributes is empty", async () => {
    const db = createMockDb([]);
    const result = await denormalizeFilterableAttributeLabels(db, "company1", "account1", {});
    expect(result).toEqual({});
  });

  it("returns {} when filterableAttributes is null/undefined", async () => {
    const db = createMockDb([]);
    const result = await denormalizeFilterableAttributeLabels(db, "company1", "account1", null as any);
    expect(result).toEqual({});
  });

  it("resolves labels from the catalog", async () => {
    const db = createMockDb([
      { code: "marca", label: "Marca", companyId: "c1", accountId: "a1" },
      { code: "genero", label: "Género", companyId: "c1", accountId: "a1" },
      { code: "material", label: "Material", companyId: "c1", accountId: "a1" },
    ]);

    const result = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {
      marca: ["Nike"],
      genero: ["Hombre"],
    });

    expect(result).toEqual({
      marca: "Marca",
      genero: "Género",
    });
  });

  it("omits codes not found in the catalog (no error)", async () => {
    const db = createMockDb([
      { code: "marca", label: "Marca", companyId: "c1", accountId: "a1" },
    ]);

    const result = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {
      marca: ["Nike"],
      nonexistent: ["Value"],
    });

    expect(result).toEqual({
      marca: "Marca",
    });
  });

  it("handles case-insensitive code matching", async () => {
    const db = createMockDb([
      { code: "MARCA", label: "Marca", companyId: "c1", accountId: "a1" },
    ]);

    const result = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {
      marca: ["Nike"],
    });

    expect(result).toEqual({
      marca: "Marca",
    });
  });

  it("only returns labels for the correct company/account", async () => {
    const db = createMockDb([
      { code: "marca", label: "Marca", companyId: "c1", accountId: "a1" },
      { code: "marca", label: "Brand", companyId: "c2", accountId: "a2" },
    ]);

    const result = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {
      marca: ["Nike"],
    });

    expect(result).toEqual({
      marca: "Marca",
    });
  });

  it("handles catalog entries with empty labels by omitting them", async () => {
    const db = createMockDb([
      { code: "marca", label: "", companyId: "c1", accountId: "a1" },
    ]);

    const result = await denormalizeFilterableAttributeLabels(db, "c1", "a1", {
      marca: ["Nike"],
    });

    // Empty label means the code won't be included (typeMap.get returns "" which is falsy)
    expect(result).toEqual({});
  });
});

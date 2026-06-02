import { describe, it, expect } from "vitest";
import { normalizeFilterableAttributeLabels } from "../integration/mappers/product.mapper.js";

describe("normalizeFilterableAttributeLabels", () => {
  it("returns {} when filterableAttributes is empty", () => {
    const data = { filterableAttributeLabels: { marca: "Marca" } };
    const filterableAttributes: Record<string, string[]> = {};
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({});
  });

  it("includes only codes present in filterableAttributes", () => {
    const data = {
      filterableAttributeLabels: {
        marca: "Marca",
        genero: "Género",
        material: "Material",
      },
    };
    const filterableAttributes = { marca: ["Nike"], genero: ["Hombre"] };
    const result = normalizeFilterableAttributeLabels(data, filterableAttributes);
    expect(result).toEqual({ marca: "Marca", genero: "Género" });
    expect(result).not.toHaveProperty("material");
  });

  it("uses denormalized label when present and non-empty", () => {
    const data = { filterableAttributeLabels: { marca: "Marca" } };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "Marca",
    });
  });

  it("falls back to code when label is missing", () => {
    const data = { filterableAttributeLabels: {} };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "marca",
    });
  });

  it("falls back to code when label is empty string", () => {
    const data = { filterableAttributeLabels: { marca: "" } };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "marca",
    });
  });

  it("falls back to code when label is whitespace-only", () => {
    const data = { filterableAttributeLabels: { marca: "   " } };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "marca",
    });
  });

  it("falls back to code when filterableAttributeLabels is null", () => {
    const data = { filterableAttributeLabels: null };
    const filterableAttributes = { marca: ["Nike"], genero: ["Hombre"] };
    expect(normalizeFilterableAttributeLabels(data as any, filterableAttributes)).toEqual({
      marca: "marca",
      genero: "genero",
    });
  });

  it("falls back to code when filterableAttributeLabels is undefined", () => {
    const data = {};
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "marca",
    });
  });

  it("falls back to code when filterableAttributeLabels is an array (invalid)", () => {
    const data = { filterableAttributeLabels: ["Marca", "Género"] };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data as any, filterableAttributes)).toEqual({
      marca: "marca",
    });
  });

  it("trims label values", () => {
    const data = { filterableAttributeLabels: { marca: "  Marca  " } };
    const filterableAttributes = { marca: ["Nike"] };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "Marca",
    });
  });

  it("handles multiple codes with mixed label availability", () => {
    const data = {
      filterableAttributeLabels: {
        marca: "Marca",
        genero: "",
        material: "Material",
      },
    };
    const filterableAttributes = {
      marca: ["Nike"],
      genero: ["Hombre"],
      material: ["Cuero"],
      estilo: ["Casual"],
    };
    expect(normalizeFilterableAttributeLabels(data, filterableAttributes)).toEqual({
      marca: "Marca",
      genero: "genero",
      material: "Material",
      estilo: "estilo",
    });
  });
});

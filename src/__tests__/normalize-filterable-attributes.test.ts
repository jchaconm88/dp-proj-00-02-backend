import { describe, it, expect } from "vitest";
import { normalizeFilterableAttributes } from "../integration/mappers/product.mapper.js";

describe("normalizeFilterableAttributes", () => {
  it("returns {} when filterableAttributes is missing", () => {
    expect(normalizeFilterableAttributes({})).toEqual({});
  });

  it("returns {} when filterableAttributes is null", () => {
    expect(normalizeFilterableAttributes({ filterableAttributes: null })).toEqual({});
  });

  it("returns {} when filterableAttributes is undefined", () => {
    expect(normalizeFilterableAttributes({ filterableAttributes: undefined })).toEqual({});
  });

  it("returns {} when filterableAttributes is an array", () => {
    expect(normalizeFilterableAttributes({ filterableAttributes: ["a", "b"] })).toEqual({});
  });

  it("returns {} when filterableAttributes is a primitive", () => {
    expect(normalizeFilterableAttributes({ filterableAttributes: "string" })).toEqual({});
    expect(normalizeFilterableAttributes({ filterableAttributes: 123 })).toEqual({});
  });

  it("normalizes codes to lowercase", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { MARCA: ["Nike"], Genero: ["Hombre"] },
    });
    expect(result).toEqual({ marca: ["Nike"], genero: ["Hombre"] });
  });

  it("trims whitespace from codes", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { "  marca  ": ["Nike"] },
    });
    expect(result).toEqual({ marca: ["Nike"] });
  });

  it("coerces single string value to one-element array", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: "Nike" },
    });
    expect(result).toEqual({ marca: ["Nike"] });
  });

  it("omits codes with null value", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: null, genero: ["Hombre"] },
    });
    expect(result).toEqual({ genero: ["Hombre"] });
  });

  it("omits codes with empty string value", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: "", genero: ["Hombre"] },
    });
    expect(result).toEqual({ genero: ["Hombre"] });
  });

  it("omits codes with whitespace-only string value", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: "   ", genero: ["Hombre"] },
    });
    expect(result).toEqual({ genero: ["Hombre"] });
  });

  it("omits codes with empty array value", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: [], genero: ["Hombre"] },
    });
    expect(result).toEqual({ genero: ["Hombre"] });
  });

  it("filters out empty strings from array values", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { material: ["Cuero", "", "Textil", "  "] },
    });
    expect(result).toEqual({ material: ["Cuero", "Textil"] });
  });

  it("omits code if all array values are empty after filtering", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { material: ["", "  ", ""] },
    });
    expect(result).toEqual({});
  });

  it("handles a complete valid product with multiple attributes", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: {
        marca: ["Nike"],
        genero: ["Hombre"],
        material: ["Cuero", "Textil"],
      },
    });
    expect(result).toEqual({
      marca: ["Nike"],
      genero: ["Hombre"],
      material: ["Cuero", "Textil"],
    });
  });

  it("skips codes that become empty after trim+lowercase", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { "   ": ["Nike"], marca: ["Adidas"] },
    });
    expect(result).toEqual({ marca: ["Adidas"] });
  });

  it("converts non-string array elements to strings", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { size: [42, 44, 46] },
    });
    expect(result).toEqual({ size: ["42", "44", "46"] });
  });

  it("omits codes with numeric value (not string, not array)", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: 123 },
    });
    expect(result).toEqual({});
  });

  it("omits codes with boolean value", () => {
    const result = normalizeFilterableAttributes({
      filterableAttributes: { marca: true },
    });
    expect(result).toEqual({});
  });
});

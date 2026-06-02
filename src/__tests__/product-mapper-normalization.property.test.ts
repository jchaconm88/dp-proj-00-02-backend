/**
 * Feature: filterable-product-attributes, Property 8: Product_Mapper filterable_attributes normalization
 *
 * **Validates: Requirements 3.1, 3.3, 3.6, 3.8**
 *
 * For any product record, the Integration API `filterable_attributes` field SHALL:
 * normalize all codes to lowercase, coerce single string values to one-element arrays,
 * and omit any code whose value is null, empty string, or empty array.
 * When the product has no filterable attributes, the field SHALL be an empty object `{}`.
 *
 * Tag: Feature: filterable-product-attributes, Property 8: Product_Mapper filterable_attributes normalization
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { normalizeFilterableAttributes } from "../integration/mappers/product.mapper.js";

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid attribute code: 1-20 chars, may include uppercase for normalization testing */
const arbCode = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/).filter(
  (s) => !["__proto__", "constructor", "prototype", "toString", "valueOf"].includes(s.toLowerCase())
);

/** Non-empty value string (after trim) */
const arbNonEmptyValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

/** A value that is considered "empty" (null, empty string, whitespace-only) */
const arbEmptyValue = fc.oneof(
  fc.constant(null),
  fc.constant(""),
  fc.constant("   "),
  fc.constant(undefined)
);

/** A non-empty array of non-empty string values */
const arbNonEmptyArray = fc.array(arbNonEmptyValue, { minLength: 1, maxLength: 5 });

/** An empty array */
const arbEmptyArray = fc.constant([] as string[]);

/** An array that contains only empty/whitespace strings */
const arbAllEmptyArray = fc.array(
  fc.oneof(fc.constant(""), fc.constant("  "), fc.constant("\t")),
  { minLength: 1, maxLength: 5 }
);

/**
 * Generates a valid filterableAttributes map where all codes have non-empty
 * array values (the "happy path" scenario).
 */
const arbValidFilterableAttributes = fc
  .array(
    fc.tuple(arbCode, arbNonEmptyArray),
    { minLength: 1, maxLength: 8 }
  )
  .map((entries) => {
    const map: Record<string, unknown> = {};
    for (const [code, values] of entries) {
      if (code.trim().length > 0) {
        map[code] = values;
      }
    }
    return map;
  })
  .filter((m) => Object.keys(m).length > 0);

/**
 * Generates a filterableAttributes map with a mix of valid values,
 * single string values, null values, empty strings, and empty arrays.
 */
const arbMixedFilterableAttributes = fc
  .array(
    fc.tuple(
      arbCode,
      fc.oneof(
        arbNonEmptyArray,                    // valid array
        arbNonEmptyValue.map((v) => v),      // single string (to be coerced)
        arbEmptyValue,                       // null/empty/undefined
        arbEmptyArray,                       // empty array
        arbAllEmptyArray                     // array of only empty strings
      )
    ),
    { minLength: 1, maxLength: 10 }
  )
  .map((entries) => {
    const map: Record<string, unknown> = {};
    for (const [code, value] of entries) {
      if (code.trim().length > 0) {
        map[code] = value;
      }
    }
    return map;
  })
  .filter((m) => Object.keys(m).length > 0);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 8: Product_Mapper filterable_attributes normalization", () => {
  it("SHALL normalize all codes to lowercase", () => {
    fc.assert(
      fc.property(arbValidFilterableAttributes, (attrs) => {
        const data = { filterableAttributes: attrs };
        const result = normalizeFilterableAttributes(data);

        // Every key in the result must be lowercase
        for (const key of Object.keys(result)) {
          expect(key).toBe(key.toLowerCase());
        }

        // Every input code (trimmed, lowercased) with valid values must appear in result
        for (const [inputCode, inputVal] of Object.entries(attrs)) {
          const normalized = inputCode.trim().toLowerCase();
          if (!normalized) continue;
          if (Array.isArray(inputVal)) {
            const filtered = (inputVal as unknown[]).map(String).filter((v) => v.trim() !== "");
            if (filtered.length > 0) {
              expect(result).toHaveProperty(normalized);
            }
          } else if (inputVal && typeof inputVal === "string" && inputVal.trim() !== "") {
            expect(result).toHaveProperty(normalized);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("SHALL coerce single string values to one-element arrays", () => {
    // Generate attributes where all values are single non-empty strings
    const arbSingleStringAttrs = fc
      .array(
        fc.tuple(arbCode, arbNonEmptyValue),
        { minLength: 1, maxLength: 8 }
      )
      .map((entries) => {
        const map: Record<string, unknown> = {};
        for (const [code, value] of entries) {
          if (code.trim().length > 0) {
            map[code] = value; // single string, not array
          }
        }
        return map;
      })
      .filter((m) => Object.keys(m).length > 0);

    fc.assert(
      fc.property(arbSingleStringAttrs, (attrs) => {
        const data = { filterableAttributes: attrs };
        const result = normalizeFilterableAttributes(data);

        // Every result value must be an array
        for (const values of Object.values(result)) {
          expect(Array.isArray(values)).toBe(true);
          expect(values.length).toBe(1);
        }

        // The single string value must be wrapped in an array
        for (const [inputCode, inputVal] of Object.entries(attrs)) {
          const normalized = inputCode.trim().toLowerCase();
          if (!normalized) continue;
          if (typeof inputVal === "string" && inputVal.trim() !== "") {
            expect(result[normalized]).toEqual([inputVal]);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("SHALL omit any code whose value is null, empty string, or empty array", () => {
    fc.assert(
      fc.property(arbMixedFilterableAttributes, (attrs) => {
        const data = { filterableAttributes: attrs };
        const result = normalizeFilterableAttributes(data);

        for (const [inputCode, inputVal] of Object.entries(attrs)) {
          const normalized = inputCode.trim().toLowerCase();
          if (!normalized) continue;

          const shouldBeOmitted =
            inputVal === null ||
            inputVal === undefined ||
            (typeof inputVal === "string" && inputVal.trim() === "") ||
            (Array.isArray(inputVal) && inputVal.length === 0) ||
            (Array.isArray(inputVal) && inputVal.every((v) => String(v).trim() === ""));

          if (shouldBeOmitted) {
            // Code should NOT appear in result
            // Note: another entry with same normalized code might provide a valid value
            // so we only check if no other entry provides a valid value for this code
            const otherValidEntry = Object.entries(attrs).some(([otherCode, otherVal]) => {
              if (otherCode === inputCode) return false;
              const otherNormalized = String(otherCode).trim().toLowerCase();
              if (otherNormalized !== normalized) return false;
              // Check if otherVal is valid
              if (Array.isArray(otherVal)) {
                return otherVal.some((v) => String(v).trim() !== "");
              }
              if (typeof otherVal === "string" && otherVal.trim() !== "") return true;
              return false;
            });
            if (!otherValidEntry) {
              expect(result[normalized]).toBeUndefined();
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("SHALL return empty object when product has no filterable attributes", () => {
    // Test various "no attributes" scenarios
    const arbNoAttributes = fc.oneof(
      fc.constant({}),
      fc.constant({ filterableAttributes: null }),
      fc.constant({ filterableAttributes: undefined }),
      fc.constant({ filterableAttributes: [] }),
      fc.constant({ filterableAttributes: "not-an-object" }),
      fc.constant({ filterableAttributes: 123 }),
      fc.constant({ otherField: "value" })
    );

    fc.assert(
      fc.property(arbNoAttributes, (data) => {
        const result = normalizeFilterableAttributes(data as Record<string, unknown>);
        expect(result).toEqual({});
      }),
      { numRuns: 100 }
    );
  });

  it("SHALL return empty object when all attribute values are empty/null", () => {
    // Generate attributes where ALL values are empty/null/undefined
    const arbAllEmptyAttrs = fc
      .array(
        fc.tuple(
          arbCode,
          fc.oneof(arbEmptyValue, arbEmptyArray, arbAllEmptyArray)
        ),
        { minLength: 1, maxLength: 8 }
      )
      .map((entries) => {
        const map: Record<string, unknown> = {};
        for (const [code, value] of entries) {
          if (code.trim().length > 0) {
            map[code] = value;
          }
        }
        return map;
      })
      .filter((m) => Object.keys(m).length > 0);

    fc.assert(
      fc.property(arbAllEmptyAttrs, (attrs) => {
        const data = { filterableAttributes: attrs };
        const result = normalizeFilterableAttributes(data);
        expect(result).toEqual({});
      }),
      { numRuns: 100 }
    );
  });

  it("result values SHALL always be arrays of non-empty strings", () => {
    fc.assert(
      fc.property(arbMixedFilterableAttributes, (attrs) => {
        const data = { filterableAttributes: attrs };
        const result = normalizeFilterableAttributes(data);

        for (const [code, values] of Object.entries(result)) {
          // Key must be lowercase, trimmed, non-empty
          expect(code).toBe(code.toLowerCase());
          expect(code.trim()).toBe(code);
          expect(code.length).toBeGreaterThan(0);

          // Value must be a non-empty array of non-empty strings
          expect(Array.isArray(values)).toBe(true);
          expect(values.length).toBeGreaterThan(0);
          for (const v of values) {
            expect(typeof v).toBe("string");
            expect(v.trim().length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

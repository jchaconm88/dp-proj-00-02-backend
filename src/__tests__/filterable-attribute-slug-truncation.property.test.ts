/**
 * Feature: filterable-product-attributes, Property 11: Slug truncation at 28 characters
 *
 * **Validates: Requirements 4.9, 5.2, 5.7**
 *
 * For any filterable attribute label, the derived taxonomy slug (via
 * `wc_sanitize_taxonomy_name`) SHALL NOT exceed 28 characters. If the raw slug
 * exceeds 28 characters, it SHALL be truncated to exactly 28 characters.
 *
 * Tag: Feature: filterable-product-attributes, Property 11: Slug truncation at 28 characters
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TAXONOMY_SLUG_LENGTH = 28;

// ─── TypeScript simulation of wc_sanitize_taxonomy_name ──────────────────────

/**
 * Simulates WooCommerce's `wc_sanitize_taxonomy_name()` behavior:
 * 1. Lowercase the input
 * 2. Remove diacritics (normalize to NFD, strip combining marks)
 * 3. Replace non-alphanumeric characters with hyphens
 * 4. Collapse consecutive hyphens into one
 * 5. Trim leading/trailing hyphens
 */
function wcSanitizeTaxonomyName(label: string): string {
  let slug = label.toLowerCase();

  // Remove diacritics: normalize to NFD decomposition, then strip combining marks
  slug = slug.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Replace any non-alphanumeric character (not a-z, 0-9) with a hyphen
  slug = slug.replace(/[^a-z0-9]/g, "-");

  // Collapse consecutive hyphens
  slug = slug.replace(/-+/g, "-");

  // Trim leading and trailing hyphens
  slug = slug.replace(/^-+|-+$/g, "");

  return slug;
}

/**
 * Applies the slug truncation logic as implemented in the Sync_Plugin:
 * If the sanitized slug exceeds 28 characters, truncate to exactly 28.
 */
function deriveFilterableAttributeSlug(label: string): {
  slug: string;
  rawSlug: string;
  wasTruncated: boolean;
} {
  const rawSlug = wcSanitizeTaxonomyName(label);
  const wasTruncated = rawSlug.length > MAX_TAXONOMY_SLUG_LENGTH;
  const slug = wasTruncated
    ? rawSlug.substring(0, MAX_TAXONOMY_SLUG_LENGTH)
    : rawSlug;

  return { slug, rawSlug, wasTruncated };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Arbitrary label: any non-empty string (1-100 chars) simulating real attribute labels */
const arbLabel = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);

/** Labels that are short enough to produce slugs ≤ 28 chars after sanitization */
const arbShortLabel = fc
  .string({ minLength: 1, maxLength: 25 })
  .filter((s) => {
    const sanitized = wcSanitizeTaxonomyName(s);
    return sanitized.length > 0 && sanitized.length <= MAX_TAXONOMY_SLUG_LENGTH;
  });

/** Labels that are long enough to produce slugs > 28 chars after sanitization */
const arbLongLabel = fc
  .string({ minLength: 30, maxLength: 100 })
  .filter((s) => {
    const sanitized = wcSanitizeTaxonomyName(s);
    return sanitized.length > MAX_TAXONOMY_SLUG_LENGTH;
  });

/** Labels with diacritics (common in Spanish/Portuguese attribute names) */
const arbDiacriticLabel = fc
  .constantFrom(
    "Género de Producto Específico",
    "Categoría de Artículos Electrónicos",
    "Información Técnica del Fabricante",
    "Características Físicas del Material",
    "Descripción Detallada del Artículo",
    "Composición Química del Producto",
    "Dimensión Máxima Permitida Estándar"
  );

/** Labels composed of only alphanumeric characters (no sanitization needed beyond lowercase) */
const arbAlphanumericLabel = fc.stringMatching(/^[a-zA-Z0-9]{1,60}$/);

/** Labels with mixed unicode, spaces, and special characters */
const arbMixedLabel = fc
  .tuple(
    fc.array(
      fc.oneof(
        fc.stringMatching(/^[a-zA-Z]{1,10}$/),
        fc.stringMatching(/^[0-9]{1,5}$/),
        fc.constantFrom(" ", "-", "_", ".", "/", "&", "(", ")")
      ),
      { minLength: 3, maxLength: 15 }
    )
  )
  .map(([parts]) => parts.join(""))
  .filter((s) => wcSanitizeTaxonomyName(s).length > 0);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 11: Slug truncation at 28 characters", () => {
  it("derived slug SHALL NOT exceed 28 characters for any label", () => {
    fc.assert(
      fc.property(arbLabel, (label) => {
        const { slug } = deriveFilterableAttributeSlug(label);

        // The final slug must never exceed 28 characters
        expect(slug.length).toBeLessThanOrEqual(MAX_TAXONOMY_SLUG_LENGTH);
      }),
      { numRuns: 100 }
    );
  });

  it("if raw slug exceeds 28 characters, it SHALL be truncated to exactly 28 characters", () => {
    fc.assert(
      fc.property(arbLongLabel, (label) => {
        const { slug, rawSlug, wasTruncated } = deriveFilterableAttributeSlug(label);

        // The raw slug must exceed 28 chars (precondition from generator)
        expect(rawSlug.length).toBeGreaterThan(MAX_TAXONOMY_SLUG_LENGTH);

        // It must have been truncated
        expect(wasTruncated).toBe(true);

        // The truncated slug must be exactly 28 characters
        expect(slug.length).toBe(MAX_TAXONOMY_SLUG_LENGTH);

        // The truncated slug must be a prefix of the raw slug
        expect(rawSlug.startsWith(slug)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("if raw slug is ≤ 28 characters, it SHALL NOT be truncated", () => {
    fc.assert(
      fc.property(arbShortLabel, (label) => {
        const { slug, rawSlug, wasTruncated } = deriveFilterableAttributeSlug(label);

        // The raw slug must be ≤ 28 chars (precondition from generator)
        expect(rawSlug.length).toBeLessThanOrEqual(MAX_TAXONOMY_SLUG_LENGTH);

        // It must NOT have been truncated
        expect(wasTruncated).toBe(false);

        // The slug must equal the raw slug (no modification)
        expect(slug).toBe(rawSlug);
      }),
      { numRuns: 100 }
    );
  });

  it("slug truncation preserves the first 28 characters of the sanitized slug", () => {
    fc.assert(
      fc.property(arbLongLabel, (label) => {
        const { slug, rawSlug } = deriveFilterableAttributeSlug(label);

        // The truncated slug must be exactly the first 28 chars of the raw slug
        expect(slug).toBe(rawSlug.substring(0, MAX_TAXONOMY_SLUG_LENGTH));
      }),
      { numRuns: 100 }
    );
  });

  it("diacritics in labels are removed before slug derivation and truncation", () => {
    fc.assert(
      fc.property(arbDiacriticLabel, (label) => {
        const { slug, rawSlug } = deriveFilterableAttributeSlug(label);

        // Slug must not contain diacritics (only a-z, 0-9, hyphens)
        expect(slug).toMatch(/^[a-z0-9-]*$/);

        // Slug must not exceed 28 characters
        expect(slug.length).toBeLessThanOrEqual(MAX_TAXONOMY_SLUG_LENGTH);

        // If raw slug exceeds 28, truncation must have occurred
        if (rawSlug.length > MAX_TAXONOMY_SLUG_LENGTH) {
          expect(slug.length).toBe(MAX_TAXONOMY_SLUG_LENGTH);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("sanitized slug contains only lowercase alphanumeric characters and hyphens", () => {
    fc.assert(
      fc.property(arbMixedLabel, (label) => {
        const { slug } = deriveFilterableAttributeSlug(label);

        // Slug must only contain a-z, 0-9, and hyphens
        expect(slug).toMatch(/^[a-z0-9-]*$/);

        // Slug must not start or end with a hyphen (before truncation)
        // Note: after truncation, it COULD end with a hyphen (truncation is a raw substring)
        // but the raw slug (before truncation) must not start/end with hyphens
        const { rawSlug } = deriveFilterableAttributeSlug(label);
        if (rawSlug.length > 0) {
          expect(rawSlug[0]).not.toBe("-");
          expect(rawSlug[rawSlug.length - 1]).not.toBe("-");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("alphanumeric-only labels produce slugs that are just the lowercase version (up to 28 chars)", () => {
    fc.assert(
      fc.property(arbAlphanumericLabel, (label) => {
        const { slug, rawSlug } = deriveFilterableAttributeSlug(label);

        // For purely alphanumeric labels, the raw slug is just the lowercase version
        expect(rawSlug).toBe(label.toLowerCase());

        // And the final slug is truncated to 28 if needed
        expect(slug.length).toBeLessThanOrEqual(MAX_TAXONOMY_SLUG_LENGTH);
        if (label.length > MAX_TAXONOMY_SLUG_LENGTH) {
          expect(slug.length).toBe(MAX_TAXONOMY_SLUG_LENGTH);
        }
      }),
      { numRuns: 100 }
    );
  });
});

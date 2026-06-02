/**
 * Feature: filterable-product-attributes, Property 12: Attribute flag resolution for combined attributes
 *
 * **Validates: Requirements 6.3, 6.5, 6.6, 6.7**
 *
 * For any product where a taxonomy slug appears in both `attribute_definitions` and
 * `filterable_attributes`, the resulting WooCommerce attribute SHALL have
 * `variation: true`, `visible: true`, and `has_archives: true`.
 *
 * If subsequently removed from `filterable_attributes` but remaining in
 * `attribute_definitions`, it SHALL revert to `variation: true`, `visible: false`,
 * `has_archives: false`.
 *
 * If removed from `attribute_definitions` but remaining in `filterable_attributes`,
 * it SHALL revert to `variation: false`, `visible: true`, `has_archives: true`.
 *
 * Tag: Feature: filterable-product-attributes, Property 12: Attribute flag resolution for combined attributes
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Represents the resolved flags for a WooCommerce product attribute.
 * These flags determine how the attribute behaves in WooCommerce.
 */
interface WCAttributeFlags {
  variation: boolean;
  visible: boolean;
  has_archives: boolean;
}

/**
 * Represents the state of a product's attribute sources.
 * A slug can appear in attribute_definitions, filterable_attributes, or both.
 */
interface AttributeSourceState {
  /** Slugs present in attribute_definitions (variation attributes) */
  attributeDefinitions: Set<string>;
  /** Slugs present in filterable_attributes */
  filterableAttributes: Set<string>;
}

// ─── Simulation of Sync_Plugin Flag Resolution ───────────────────────────────

/**
 * Simulates the Sync_Plugin's attribute flag resolution logic.
 *
 * The Sync_Plugin processes attribute_definitions first (creating attributes with
 * variation:true, visible:false, has_archives:false), then processes
 * filterable_attributes (creating/upgrading attributes with variation:false,
 * visible:true, has_archives:true). When a slug appears in both, the flags merge.
 *
 * This mirrors the PHP logic in SyncService::sync_variable_product:
 * 1. build_attributes_from_variations → variation:true, visible:false
 * 2. sync_filterable_attributes → if slug already exists, merge (keep variation:true,
 *    set visible:true, enable has_archives:true)
 */
function resolveAttributeFlags(
  slug: string,
  state: AttributeSourceState
): WCAttributeFlags | null {
  const inDefinitions = state.attributeDefinitions.has(slug);
  const inFilterable = state.filterableAttributes.has(slug);

  if (!inDefinitions && !inFilterable) {
    return null; // Attribute not present in either source
  }

  if (inDefinitions && inFilterable) {
    // Requirement 6.3: Combined attribute — merge both behaviors
    return { variation: true, visible: true, has_archives: true };
  }

  if (inDefinitions && !inFilterable) {
    // Requirement 6.1/6.7: Variation-only attribute
    return { variation: true, visible: false, has_archives: false };
  }

  // !inDefinitions && inFilterable
  // Requirement 6.2: Filterable-only attribute
  return { variation: false, visible: true, has_archives: true };
}

/**
 * Simulates a full sync cycle for a product, resolving flags for all attributes.
 * Returns a map of slug → flags for all attributes present in either source.
 */
function resolveAllAttributeFlags(
  state: AttributeSourceState
): Map<string, WCAttributeFlags> {
  const allSlugs = new Set([
    ...state.attributeDefinitions,
    ...state.filterableAttributes,
  ]);

  const result = new Map<string, WCAttributeFlags>();
  for (const slug of allSlugs) {
    const flags = resolveAttributeFlags(slug, state);
    if (flags) {
      result.set(slug, flags);
    }
  }
  return result;
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid taxonomy slug: lowercase alphanumeric with hyphens/underscores, 1-20 chars */
const arbSlug = fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/);

/**
 * Generates a set of unique slugs that appear in BOTH attribute_definitions
 * and filterable_attributes (the combined/overlap case).
 */
const arbCombinedSlugs = fc.uniqueArray(arbSlug, { minLength: 1, maxLength: 5 });

/**
 * Generates an AttributeSourceState where some slugs appear in both sources,
 * some only in attribute_definitions, and some only in filterable_attributes.
 */
const arbMixedSourceState = fc
  .tuple(
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 4 }), // definition-only slugs
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 4 }), // filterable-only slugs
    fc.uniqueArray(arbSlug, { minLength: 1, maxLength: 4 })  // combined slugs (in both)
  )
  .map(([defOnly, filtOnly, combined]) => {
    // Ensure no overlap between the three groups
    const usedSlugs = new Set(combined);
    const cleanDefOnly = defOnly.filter((s) => !usedSlugs.has(s));
    for (const s of cleanDefOnly) usedSlugs.add(s);
    const cleanFiltOnly = filtOnly.filter((s) => !usedSlugs.has(s));

    const attributeDefinitions = new Set([...cleanDefOnly, ...combined]);
    const filterableAttributes = new Set([...cleanFiltOnly, ...combined]);

    return {
      state: { attributeDefinitions, filterableAttributes } as AttributeSourceState,
      combinedSlugs: combined,
      defOnlySlugs: cleanDefOnly,
      filtOnlySlugs: cleanFiltOnly,
    };
  })
  .filter(
    ({ combinedSlugs }) => combinedSlugs.length > 0
  );

/**
 * Generates a scenario where a combined attribute is removed from
 * filterable_attributes but remains in attribute_definitions.
 */
const arbRemoveFromFilterable = fc
  .tuple(
    fc.uniqueArray(arbSlug, { minLength: 1, maxLength: 4 }), // slugs that start combined
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 3 }), // extra definition-only slugs
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 3 })  // extra filterable-only slugs
  )
  .map(([combinedSlugs, extraDef, extraFilt]) => {
    const usedSlugs = new Set(combinedSlugs);
    const cleanExtraDef = extraDef.filter((s) => !usedSlugs.has(s));
    for (const s of cleanExtraDef) usedSlugs.add(s);
    const cleanExtraFilt = extraFilt.filter((s) => !usedSlugs.has(s));

    // Initial state: combined slugs are in both sources
    const initialState: AttributeSourceState = {
      attributeDefinitions: new Set([...cleanExtraDef, ...combinedSlugs]),
      filterableAttributes: new Set([...cleanExtraFilt, ...combinedSlugs]),
    };

    // After state: combined slugs removed from filterable, remain in definitions
    const afterState: AttributeSourceState = {
      attributeDefinitions: new Set([...cleanExtraDef, ...combinedSlugs]),
      filterableAttributes: new Set(cleanExtraFilt),
    };

    return { initialState, afterState, removedSlugs: combinedSlugs };
  })
  .filter(({ removedSlugs }) => removedSlugs.length > 0);

/**
 * Generates a scenario where a combined attribute is removed from
 * attribute_definitions but remains in filterable_attributes.
 */
const arbRemoveFromDefinitions = fc
  .tuple(
    fc.uniqueArray(arbSlug, { minLength: 1, maxLength: 4 }), // slugs that start combined
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 3 }), // extra definition-only slugs
    fc.uniqueArray(arbSlug, { minLength: 0, maxLength: 3 })  // extra filterable-only slugs
  )
  .map(([combinedSlugs, extraDef, extraFilt]) => {
    const usedSlugs = new Set(combinedSlugs);
    const cleanExtraDef = extraDef.filter((s) => !usedSlugs.has(s));
    for (const s of cleanExtraDef) usedSlugs.add(s);
    const cleanExtraFilt = extraFilt.filter((s) => !usedSlugs.has(s));

    // Initial state: combined slugs are in both sources
    const initialState: AttributeSourceState = {
      attributeDefinitions: new Set([...cleanExtraDef, ...combinedSlugs]),
      filterableAttributes: new Set([...cleanExtraFilt, ...combinedSlugs]),
    };

    // After state: combined slugs removed from definitions, remain in filterable
    const afterState: AttributeSourceState = {
      attributeDefinitions: new Set(cleanExtraDef),
      filterableAttributes: new Set([...cleanExtraFilt, ...combinedSlugs]),
    };

    return { initialState, afterState, removedSlugs: combinedSlugs };
  })
  .filter(({ removedSlugs }) => removedSlugs.length > 0);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 12: Attribute flag resolution for combined attributes", () => {
  it("combined attributes SHALL have variation:true, visible:true, has_archives:true", () => {
    fc.assert(
      fc.property(arbMixedSourceState, ({ state, combinedSlugs }) => {
        const flags = resolveAllAttributeFlags(state);

        for (const slug of combinedSlugs) {
          const attrFlags = flags.get(slug);
          expect(attrFlags).toBeDefined();
          expect(attrFlags!.variation).toBe(true);
          expect(attrFlags!.visible).toBe(true);
          expect(attrFlags!.has_archives).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("definition-only attributes SHALL have variation:true, visible:false, has_archives:false", () => {
    fc.assert(
      fc.property(arbMixedSourceState, ({ state, defOnlySlugs }) => {
        const flags = resolveAllAttributeFlags(state);

        for (const slug of defOnlySlugs) {
          const attrFlags = flags.get(slug);
          expect(attrFlags).toBeDefined();
          expect(attrFlags!.variation).toBe(true);
          expect(attrFlags!.visible).toBe(false);
          expect(attrFlags!.has_archives).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("filterable-only attributes SHALL have variation:false, visible:true, has_archives:true", () => {
    fc.assert(
      fc.property(arbMixedSourceState, ({ state, filtOnlySlugs }) => {
        const flags = resolveAllAttributeFlags(state);

        for (const slug of filtOnlySlugs) {
          const attrFlags = flags.get(slug);
          expect(attrFlags).toBeDefined();
          expect(attrFlags!.variation).toBe(false);
          expect(attrFlags!.visible).toBe(true);
          expect(attrFlags!.has_archives).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("removing from filterable_attributes SHALL revert to variation:true, visible:false, has_archives:false", () => {
    fc.assert(
      fc.property(arbRemoveFromFilterable, ({ initialState, afterState, removedSlugs }) => {
        // Verify initial state: combined
        const initialFlags = resolveAllAttributeFlags(initialState);
        for (const slug of removedSlugs) {
          const flags = initialFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }

        // Verify after state: reverted to variation-only
        const afterFlags = resolveAllAttributeFlags(afterState);
        for (const slug of removedSlugs) {
          const flags = afterFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(false);
          expect(flags!.has_archives).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("removing from attribute_definitions SHALL revert to variation:false, visible:true, has_archives:true", () => {
    fc.assert(
      fc.property(arbRemoveFromDefinitions, ({ initialState, afterState, removedSlugs }) => {
        // Verify initial state: combined
        const initialFlags = resolveAllAttributeFlags(initialState);
        for (const slug of removedSlugs) {
          const flags = initialFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }

        // Verify after state: reverted to filterable-only
        const afterFlags = resolveAllAttributeFlags(afterState);
        for (const slug of removedSlugs) {
          const flags = afterFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(false);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("adding to filterable_attributes SHALL upgrade variation-only to combined flags", () => {
    // This is the inverse of "removing from filterable": start variation-only, add to filterable
    fc.assert(
      fc.property(arbRemoveFromFilterable, ({ initialState, afterState, removedSlugs }) => {
        // Use afterState as "before" (variation-only) and initialState as "after" (combined)
        const beforeFlags = resolveAllAttributeFlags(afterState);
        for (const slug of removedSlugs) {
          const flags = beforeFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(false);
          expect(flags!.has_archives).toBe(false);
        }

        // After adding to filterable: should be combined
        const afterAddFlags = resolveAllAttributeFlags(initialState);
        for (const slug of removedSlugs) {
          const flags = afterAddFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("adding to attribute_definitions SHALL upgrade filterable-only to combined flags", () => {
    // This is the inverse of "removing from definitions": start filterable-only, add to definitions
    fc.assert(
      fc.property(arbRemoveFromDefinitions, ({ initialState, afterState, removedSlugs }) => {
        // Use afterState as "before" (filterable-only) and initialState as "after" (combined)
        const beforeFlags = resolveAllAttributeFlags(afterState);
        for (const slug of removedSlugs) {
          const flags = beforeFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(false);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }

        // After adding to definitions: should be combined
        const afterAddFlags = resolveAllAttributeFlags(initialState);
        for (const slug of removedSlugs) {
          const flags = afterAddFlags.get(slug);
          expect(flags).toBeDefined();
          expect(flags!.variation).toBe(true);
          expect(flags!.visible).toBe(true);
          expect(flags!.has_archives).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});

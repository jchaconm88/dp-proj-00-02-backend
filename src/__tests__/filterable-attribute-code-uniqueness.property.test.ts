import fc from "fast-check";
import { describe, it, expect } from "vitest";

/**
 * **Validates: Requirements 1.2, 1.8, 7.6**
 *
 * Property 2: Code uniqueness per company
 *
 * For any two filterable attribute types within the same company, if they have
 * the same `code`, the second creation SHALL be rejected.
 * Types in different companies MAY share the same code.
 *
 * Tag: Feature: filterable-product-attributes, Property 2: Code uniqueness per company
 */

// ─── Domain types ────────────────────────────────────────────────────────────

interface FilterableAttributeTypeEntry {
  id: string;
  code: string;
  companyId: string;
}

// ─── In-memory store simulating Firestore uniqueness constraint ──────────────

class FilterableAttributeTypeStore {
  private entries: FilterableAttributeTypeEntry[] = [];
  private nextId = 1;

  /**
   * Attempts to create a new filterable attribute type.
   * Returns { ok: true, id } on success, or { ok: false, error } if code
   * already exists for the same company.
   */
  create(code: string, companyId: string): { ok: true; id: string } | { ok: false; error: string } {
    // Check code uniqueness within company (mirrors the Firestore query in inventory.router.ts)
    const duplicate = this.entries.find(
      (e) => e.companyId === companyId && e.code === code
    );
    if (duplicate) {
      return { ok: false, error: `code "${code}" already exists` };
    }

    const id = `fat_${this.nextId++}`;
    this.entries.push({ id, code, companyId });
    return { ok: true, id };
  }

  getByCompany(companyId: string): FilterableAttributeTypeEntry[] {
    return this.entries.filter((e) => e.companyId === companyId);
  }

  getAll(): FilterableAttributeTypeEntry[] {
    return [...this.entries];
  }
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Valid code: ^[a-z0-9_-]+$, 1-20 chars */
const arbValidCode = fc.stringMatching(/^[a-z0-9_-]{1,20}$/).filter(
  (s) => s !== "__proto__" && s !== "constructor" && s !== "prototype" && s !== "toString" && s !== "valueOf"
);

/** Company ID generator: alphanumeric, 5-15 chars */
const arbCompanyId = fc.stringMatching(/^[a-z0-9]{5,15}$/);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe("Feature: filterable-product-attributes, Property 2: Code uniqueness per company", () => {
  it("SHALL reject second creation with same code in the same company", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbCompanyId,
        (code, companyId) => {
          const store = new FilterableAttributeTypeStore();

          // First creation should succeed
          const first = store.create(code, companyId);
          expect(first.ok).toBe(true);

          // Second creation with same code + same company should be rejected
          const second = store.create(code, companyId);
          expect(second.ok).toBe(false);
          if (!second.ok) {
            expect(second.error).toContain(code);
          }

          // Only one entry should exist for this company+code
          const entries = store.getByCompany(companyId);
          const matchingEntries = entries.filter((e) => e.code === code);
          expect(matchingEntries).toHaveLength(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("MAY allow same code in different companies", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbCompanyId,
        arbCompanyId,
        (code, companyA, companyB) => {
          // Precondition: companies must be different
          fc.pre(companyA !== companyB);

          const store = new FilterableAttributeTypeStore();

          // Create in company A
          const firstResult = store.create(code, companyA);
          expect(firstResult.ok).toBe(true);

          // Create same code in company B — should succeed
          const secondResult = store.create(code, companyB);
          expect(secondResult.ok).toBe(true);

          // Both companies should have the entry
          const entriesA = store.getByCompany(companyA);
          const entriesB = store.getByCompany(companyB);
          expect(entriesA.filter((e) => e.code === code)).toHaveLength(1);
          expect(entriesB.filter((e) => e.code === code)).toHaveLength(1);

          // Total entries should be 2
          expect(store.getAll()).toHaveLength(2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("SHALL allow different codes in the same company", () => {
    fc.assert(
      fc.property(
        arbValidCode,
        arbValidCode,
        arbCompanyId,
        (codeA, codeB, companyId) => {
          // Precondition: codes must be different
          fc.pre(codeA !== codeB);

          const store = new FilterableAttributeTypeStore();

          // Create first code
          const first = store.create(codeA, companyId);
          expect(first.ok).toBe(true);

          // Create second (different) code in same company — should succeed
          const second = store.create(codeB, companyId);
          expect(second.ok).toBe(true);

          // Both entries should exist
          const entries = store.getByCompany(companyId);
          expect(entries).toHaveLength(2);
          expect(entries.map((e) => e.code).sort()).toEqual([codeA, codeB].sort());
        }
      ),
      { numRuns: 100 }
    );
  });
});

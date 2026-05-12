// ─── Dashboard Filters ───────────────────────────────────────────────────────
// Pure utility functions for filtering dashboard elements by permission, target,
// active/visible state, and company-level overrides.
// Used in backend (snapshot composition) and replicated in frontend renderers.

// ─── filterByPermission ──────────────────────────────────────────────────────

/**
 * Filters items based on the user's effective permissions.
 * - Wildcard `*` in permissions → all items pass.
 * - Items without `permissionModule` (null/undefined) → visible to all.
 * - Items with `permissionModule` → require `{permissionModule}:view` in permissions.
 */
export function filterByPermission<T extends { permissionModule?: string | null }>(
  items: T[],
  effectivePermissions: string[]
): T[] {
  // Wildcard: user has access to everything
  if (effectivePermissions.includes("*")) {
    return items;
  }

  return items.filter((item) => {
    // No permissionModule → visible to all authenticated users
    if (item.permissionModule === null || item.permissionModule === undefined) {
      return true;
    }

    // Check for `{permissionModule}:view` in effective permissions
    return effectivePermissions.includes(`${item.permissionModule}:view`);
  });
}

// ─── filterByTarget ──────────────────────────────────────────────────────────

/**
 * Filters items by their target application.
 * Returns items where `target` matches `appTarget` or is `"both"`.
 */
export function filterByTarget<T extends { target: "admin" | "web" | "both" }>(
  items: T[],
  appTarget: "admin" | "web"
): T[] {
  return items.filter(
    (item) => item.target === appTarget || item.target === "both"
  );
}

// ─── filterActiveVisible ─────────────────────────────────────────────────────

/**
 * Filters items that are both active and visible.
 * Sorts the result by `order` field ascending (if present on items).
 */
export function filterActiveVisible<T extends { active: boolean; visible: boolean }>(
  items: T[]
): T[] {
  const filtered = items.filter((item) => item.active === true && item.visible === true);

  // Sort by order ascending if the field exists
  return filtered.sort((a, b) => {
    const orderA = (a as T & { order?: number }).order ?? 0;
    const orderB = (b as T & { order?: number }).order ?? 0;
    return orderA - orderB;
  });
}

// ─── mergeWithOverrides ──────────────────────────────────────────────────────

/**
 * Merges items with company-level overrides.
 * - If overrides is null/empty, returns items unchanged.
 * - For each item, finds a matching override by `definitionId` (matched against
 *   item's `id`, `cardKey`, or `chartKey`).
 * - Applies override's `visible` and `order` values to the item.
 */
export function mergeWithOverrides<
  T extends { id?: string; cardKey?: string; chartKey?: string; visible: boolean; order: number }
>(
  items: T[],
  overrides: Array<{
    definitionId: string;
    definitionType: "card" | "chart";
    visible: boolean;
    order: number;
  }> | null
): T[] {
  if (!overrides || overrides.length === 0) {
    return items;
  }

  return items.map((item) => {
    const override = overrides.find((o) => {
      return (
        o.definitionId === item.id ||
        o.definitionId === item.cardKey ||
        o.definitionId === item.chartKey
      );
    });

    if (!override) {
      return item;
    }

    return {
      ...item,
      visible: override.visible,
      order: override.order,
    };
  });
}

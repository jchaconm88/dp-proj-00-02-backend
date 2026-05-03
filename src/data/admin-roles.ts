import type { CatalogRoleRecord } from "./role-types.js";

const WILDCARD: Record<string, string[]> = { "*": ["*"] };

/** Catálogo default de roles del panel Admin (cuenta SaaS). Alinear con `ensureAdminRole` (name admin). */
export const ADMIN_ROLES_CATALOG: CatalogRoleRecord[] = [
  {
    id: "admin-default__admin",
    name: "admin",
    description: "Administrador de cuenta (catálogo default)",
    permissions: WILDCARD,
    permission: [],
  },
];

export function cloneAdminRoleCatalogRow(row: CatalogRoleRecord): CatalogRoleRecord {
  return {
    ...row,
    permissions: { ...row.permissions },
    permission: [...row.permission],
  };
}

export function getAdminRolesCatalog(): CatalogRoleRecord[] {
  return ADMIN_ROLES_CATALOG.map(cloneAdminRoleCatalogRow).sort((a, b) => a.name.localeCompare(b.name));
}

export function getAdminRoleCatalogById(id: string): CatalogRoleRecord | null {
  const row = ADMIN_ROLES_CATALOG.find((r) => r.id === id);
  return row ? cloneAdminRoleCatalogRow(row) : null;
}

export function getAdminRoleCatalogByName(name: string): CatalogRoleRecord | null {
  const n = String(name ?? "").trim().toLowerCase();
  const row = ADMIN_ROLES_CATALOG.find((r) => r.name.trim().toLowerCase() === n);
  return row ? cloneAdminRoleCatalogRow(row) : null;
}

export function isAdminDefaultRoleId(id: string): boolean {
  return String(id ?? "").startsWith("admin-default__");
}

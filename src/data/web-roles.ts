import type { CatalogRoleRecord } from "./role-types.js";

const WILDCARD: Record<string, string[]> = { "*": ["*"] };

/** Catálogo default de roles de app Web (empresa). Alinear con bootstrap `admin` en Firestore Web. */
export const WEB_ROLES_CATALOG: CatalogRoleRecord[] = [
  {
    id: "web-default__admin",
    name: "admin",
    description: "Administrador de empresa (catálogo default)",
    permissions: WILDCARD,
    permission: [],
  },
];

export function cloneWebRoleCatalogRow(row: CatalogRoleRecord): CatalogRoleRecord {
  return {
    ...row,
    permissions: { ...row.permissions },
    permission: [...row.permission],
  };
}

export function getWebRolesCatalog(): CatalogRoleRecord[] {
  return WEB_ROLES_CATALOG.map(cloneWebRoleCatalogRow).sort((a, b) => a.name.localeCompare(b.name));
}

export function getWebRoleCatalogById(id: string): CatalogRoleRecord | null {
  const row = WEB_ROLES_CATALOG.find((r) => r.id === id);
  return row ? cloneWebRoleCatalogRow(row) : null;
}

export function getWebRoleCatalogByName(name: string): CatalogRoleRecord | null {
  const n = String(name ?? "").trim().toLowerCase();
  const row = WEB_ROLES_CATALOG.find((r) => r.name.trim().toLowerCase() === n);
  return row ? cloneWebRoleCatalogRow(row) : null;
}

export function isWebDefaultRoleId(id: string): boolean {
  return String(id ?? "").startsWith("web-default__");
}

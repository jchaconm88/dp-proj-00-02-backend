/** Permisos por módulo (id de módulo → códigos de acción). */
export type RolePermissionsMap = Record<string, string[]>;

export type RoleSource = "default" | "custom";

/** Fila del catálogo TS (solo lectura; no hay doc en Firestore). */
export interface CatalogRoleRecord {
  id: string;
  name: string;
  description: string;
  permissions: RolePermissionsMap;
  permission: string[];
}

/** Rol expuesto en API (merge catálogo + colección `roles`). */
export interface MergedRoleRecord {
  id: string;
  companyId?: string;
  accountId?: string;
  name: string;
  description: string;
  permissions: RolePermissionsMap;
  permission: string[];
  source: RoleSource;
  readonly: boolean;
  platform?: string[];
  createBy?: string;
  createAt?: unknown;
  updateBy?: string;
  updateAt?: unknown;
}

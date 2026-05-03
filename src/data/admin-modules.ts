export interface ModulePermission {
  code: string;
  label: string;
  description: string;
}

export interface ModuleColumn {
  order: number;
  name: string;
  header: string;
  filter: boolean;
  format?: string;
}

export interface ModuleRecord {
  id: string;
  description: string;
  permissions: ModulePermission[];
  columns: ModuleColumn[];
}

const CRUD_PERMISSIONS: ModulePermission[] = [
  { code: "view", label: "Ver", description: "Permite consultar registros." },
  { code: "create", label: "Crear", description: "Permite crear registros." },
  { code: "edit", label: "Editar", description: "Permite editar registros." },
  { code: "delete", label: "Eliminar", description: "Permite eliminar registros." },
];

const ROLE_PERMISSIONS: ModulePermission[] = [
  ...CRUD_PERMISSIONS,
  { code: "permissions", label: "Gestionar permisos", description: "Permite modificar permisos por módulo." },
];

const DASHBOARD_PERMISSIONS: ModulePermission[] = [
  { code: "view", label: "Ver", description: "Permite consultar el dashboard." },
];

const COMPANY_PERMISSIONS: ModulePermission[] = [
  ...CRUD_PERMISSIONS,
  { code: "members", label: "Gestionar miembros", description: "Permite administrar miembros por empresa." },
];

function withPermissions(
  id: string,
  description: string,
  columns: ModuleColumn[],
  permissions: ModulePermission[] = CRUD_PERMISSIONS
): ModuleRecord {
  return { id, description, columns, permissions };
}

export const ADMIN_MODULES_CATALOG: ModuleRecord[] = [
  withPermissions("dashboard", "Inicio", [], DASHBOARD_PERMISSIONS),
  withPermissions("account", "Cuenta", []),
  withPermissions("company", "Empresas", [], COMPANY_PERMISSIONS),
  withPermissions("user", "Usuarios", []),
  withPermissions("role", "Roles", [], ROLE_PERMISSIONS),
  withPermissions("sequence", "Secuencias", [
    { order: 1, name: "entity", header: "Entidad", filter: true },
    { order: 2, name: "prefix", header: "Prefijo", filter: true },
    { order: 3, name: "digits", header: "Dígitos", filter: true },
    { order: 4, name: "format", header: "Formato", filter: true },
    { order: 5, name: "resetPeriod", header: "Reinicio", filter: true, format: "status" },
    { order: 6, name: "source", header: "Origen", filter: true, format: "status" },
  ]),
  withPermissions("plan", "Planes", []),
  withPermissions("subscription", "Suscripciones", []),
];

export function getAdminModuleById(id: string): ModuleRecord | null {
  const match = ADMIN_MODULES_CATALOG.find((m) => m.id === id);
  return match ? { ...match, permissions: [...match.permissions], columns: [...match.columns] } : null;
}

export function getAdminModules(): ModuleRecord[] {
  return ADMIN_MODULES_CATALOG
    .map((m) => ({ ...m, permissions: [...m.permissions], columns: [...m.columns] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

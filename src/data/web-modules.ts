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

const REPORT_PERMISSIONS: ModulePermission[] = [
  { code: "view", label: "Ver", description: "Permite consultar definiciones y ejecuciones." },
  { code: "create", label: "Crear", description: "Permite crear definiciones y ejecuciones." },
  { code: "edit", label: "Editar", description: "Permite actualizar definiciones." },
  { code: "delete", label: "Eliminar", description: "Permite eliminar definiciones." },
  { code: "run", label: "Ejecutar", description: "Permite ejecutar reportes." },
  { code: "download", label: "Descargar", description: "Permite descargar resultados." },
];

const DASHBOARD_PERMISSIONS: ModulePermission[] = [
  { code: "view", label: "Ver", description: "Permite consultar el dashboard." },
];

const COMPANY_PERMISSIONS: ModulePermission[] = [
  ...CRUD_PERMISSIONS,
  { code: "members", label: "Gestionar miembros", description: "Permite administrar miembros por empresa." },
];

const INVOICE_PERMISSIONS: ModulePermission[] = [
  ...CRUD_PERMISSIONS,
  { code: "change_status_draft", label: "Estado → Borrador", description: "Permite devolver la factura a borrador." },
  { code: "change_status_issued", label: "Estado → Emitida", description: "Permite marcar la factura como emitida (genera representación impresa PDF)." },
  { code: "change_status_queued", label: "Estado → En cola SUNAT", description: "Permite poner la factura en cola para envío a SUNAT." },
  { code: "change_status_processing", label: "Estado → Procesando SUNAT", description: "Permite marcar la factura como en procesamiento SUNAT." },
  { code: "change_status_accepted", label: "Estado → Aceptada SUNAT", description: "Permite marcar la factura como aceptada por SUNAT." },
  { code: "change_status_rejected", label: "Estado → Rechazada SUNAT", description: "Permite marcar la factura como rechazada por SUNAT." },
  { code: "change_status_pending_retry", label: "Estado → Reintentando envío", description: "Permite marcar la factura en reintento de envío a SUNAT." },
  { code: "change_status_failed", label: "Estado → Envío fallido", description: "Permite marcar la factura con fallo de envío." },
  { code: "change_status_not_found_in_sunat", label: "Estado → No encontrada en SUNAT", description: "Permite marcar la factura como no encontrada en SUNAT." },
  { code: "change_status_error", label: "Estado → Error SUNAT", description: "Permite marcar la factura con error SUNAT." },
  { code: "change_status_paid", label: "Estado → Pagada", description: "Permite marcar la factura como pagada." },
  { code: "change_status_overdue", label: "Estado → Vencida", description: "Permite marcar la factura como vencida." },
  { code: "change_status_cancelled", label: "Estado → Anulada", description: "Permite anular la factura en flujo interno." },
];

function withPermissions(
  id: string,
  description: string,
  columns: ModuleRecord["columns"],
  permissions: ModulePermission[] = CRUD_PERMISSIONS
): ModuleRecord {
  return { id, description, columns, permissions };
}

export const WEB_MODULES_CATALOG: ModuleRecord[] = [
  withPermissions("dashboard", "Inicio", [], DASHBOARD_PERMISSIONS),
  withPermissions("report", "Reportes", [], REPORT_PERMISSIONS),
  withPermissions("company", "Empresas", [
    { order: 0, name: "logoUrl", header: "Logo", filter: false },
    { order: 1, name: "name", header: "Nombre", filter: true },
    { order: 2, name: "code", header: "Código", filter: true },
    { order: 3, name: "taxId", header: "RUC / ID fiscal", filter: true },
    { order: 4, name: "companyUsers", header: "Miembros", filter: false },
    { order: 5, name: "companyLocations", header: "Sedes", filter: false },
    { order: 6, name: "status", header: "Estado", filter: true, format: "status" },
  ], COMPANY_PERMISSIONS),
  withPermissions("company-location", "Sedes de empresa", [
    { order: 1, name: "name", header: "Nombre", filter: true },
    { order: 2, name: "address", header: "Dirección", filter: true },
    { order: 3, name: "district", header: "Distrito", filter: true },
    { order: 4, name: "city", header: "Ciudad", filter: true },
    { order: 5, name: "country", header: "País", filter: true },
    { order: 6, name: "ubigeo", header: "Ubigeo", filter: true },
    { order: 7, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("user", "Usuarios", [
    { order: 1, name: "displayName", header: "Nombre", filter: true },
    { order: 2, name: "email", header: "Correo", filter: true },
  ]),
  withPermissions("role", "Roles", [
    { order: 1, name: "name", header: "Nombre", filter: true },
    { order: 2, name: "description", header: "Descripción", filter: true },
  ], ROLE_PERMISSIONS),
  withPermissions("sequence", "Secuencias", [
    { order: 1, name: "entity", header: "Entidad", filter: true },
    { order: 2, name: "prefix", header: "Prefijo", filter: true },
    { order: 3, name: "digits", header: "Dígitos", filter: true },
    { order: 4, name: "format", header: "Formato", filter: true },
    { order: 5, name: "resetPeriod", header: "Reinicio", filter: true, format: "status" },
    { order: 6, name: "allowManualOverride", header: "Override manual", filter: false, format: "bool" },
    { order: 7, name: "preventGaps", header: "Evitar huecos", filter: false, format: "bool" },
    { order: 8, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("counter", "Contadores", [
    { order: 1, name: "sequence", header: "Secuencia", filter: true },
    { order: 2, name: "period", header: "Periodo", filter: true },
    { order: 3, name: "lastNumber", header: "Último número", filter: true },
    { order: 4, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("document-sequence", "Secuencias de Documentos", [
    { order: 1, name: "sequence",      header: "Serie",            filter: true },
    { order: 2, name: "documentType",  header: "Tipo comprobante", filter: true, format: "status" },
    { order: 3, name: "currentNumber", header: "Número actual",    filter: true },
    { order: 4, name: "maxNumber",     header: "Número máximo",    filter: true },
    { order: 5, name: "active",        header: "Activo",           filter: true, format: "bool" },
  ]),
  withPermissions("document-type", "Tipos de Documento", [
    { order: 1, name: "name", header: "Nombre", filter: true },
    { order: 2, name: "description", header: "Descripción", filter: true },
    { order: 3, name: "type", header: "Categoría", filter: true, format: "status" },
  ]),
  withPermissions("client", "Clientes", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "businessName", header: "Razón social", filter: true },
    { order: 3, name: "commercialName", header: "Nombre comercial", filter: true },
    { order: 4, name: "documentType", header: "Tipo doc", filter: true },
    { order: 5, name: "documentNumber", header: "Nº documento", filter: true },
    { order: 6, name: "contactName", header: "Contacto", filter: true },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 8, name: "locations", header: "Ubicaciones", filter: false },
  ]),
  withPermissions("client-location", "Ubicaciones de cliente", [
    { order: 1, name: "name", header: "Nombre", filter: true },
    { order: 2, name: "type", header: "Tipo", filter: true },
    { order: 3, name: "address", header: "Dirección", filter: true },
    { order: 4, name: "district", header: "Distrito", filter: true },
    { order: 5, name: "city", header: "Ciudad", filter: true },
    { order: 6, name: "country", header: "País", filter: true },
    { order: 7, name: "deliveryWindowStr", header: "Ventana entrega", filter: true },
    { order: 8, name: "serviceTimeMin", header: "Tiempo serv. (min)", filter: true },
    { order: 9, name: "active", header: "Activo", filter: true },
  ]),
  withPermissions("employee", "Empleados", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "fullName", header: "Nombre", filter: true },
    { order: 3, name: "documentType", header: "Tipo Doc", filter: true },
    { order: 4, name: "documentNo", header: "Nº Doc", filter: true },
    { order: 5, name: "position", header: "Cargo", filter: true },
    { order: 6, name: "hireDate", header: "F. Ingreso", filter: true, format: "date" },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 8, name: "salaryDisplay", header: "Salario", filter: true },
  ]),
  withPermissions("position", "Cargos", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("resource", "Recursos externos", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "fullName", header: "Nombre", filter: true },
    { order: 3, name: "documentType", header: "Tipo Doc", filter: true },
    { order: 4, name: "documentNo", header: "Nº Doc", filter: true },
    { order: 5, name: "position", header: "Cargo", filter: true },
    { order: 6, name: "hireDate", header: "F. Ingreso", filter: true, format: "date" },
    { order: 7, name: "engagementType", header: "Vinculación", filter: true, format: "label" },
    { order: 8, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 9, name: "costs", header: "Costos", filter: false },
  ]),
  withPermissions("resource-cost", "Costos de recurso", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "type", header: "Tipo", filter: true, format: "status" },
    { order: 3, name: "amount", header: "Monto", filter: true },
    { order: 4, name: "currency", header: "Moneda", filter: true, format: "status" },
    { order: 5, name: "effectiveFrom", header: "Vigente desde", filter: true, format: "date" },
    { order: 6, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("order", "Pedidos", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "client", header: "Cliente", filter: true },
    { order: 3, name: "deliveryAddress", header: "Dirección entrega", filter: true },
    { order: 4, name: "locationStr", header: "Ubicación", filter: true },
    { order: 5, name: "windowStr", header: "Ventana", filter: true },
    { order: 6, name: "weight", header: "Peso", filter: true },
    { order: 7, name: "volume", header: "Volumen", filter: true },
    { order: 8, name: "status", header: "Estado", filter: true, format: "status" },
  ]),
  withPermissions("transport-service", "Servicios de transporte", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "description", header: "Descripción", filter: true },
    { order: 4, name: "category", header: "Categoría", filter: true, format: "status" },
    { order: 5, name: "defaultServiceTimeMin", header: "Tiempo (min)", filter: true },
    { order: 6, name: "calculationType", header: "Cálculo", filter: true, format: "status" },
    { order: 7, name: "requiresAppointment", header: "Cita req.", filter: false, format: "bool" },
    { order: 8, name: "allowConsolidation", header: "Consolida", filter: false, format: "bool" },
    { order: 9, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("charge-type", "Tipos de cobro", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "type", header: "Tipo", filter: true, format: "status" },
    { order: 4, name: "source", header: "Origen", filter: true, format: "label" },
    { order: 5, name: "category", header: "Categoría", filter: true, format: "label" },
    { order: 6, name: "active", header: "Activo", filter: false, format: "bool" },
  ]),
  withPermissions("transport-contract", "Contratos de transporte", [
    { order: 1, name: "contractCode", header: "Código", filter: true },
    { order: 2, name: "client", header: "Cliente", filter: true },
    { order: 3, name: "description", header: "Descripción", filter: true },
    { order: 4, name: "currency", header: "Moneda", filter: true, format: "status" },
    { order: 5, name: "validityStr", header: "Vigencia", filter: true },
    { order: 6, name: "billingCycle", header: "Facturación", filter: true, format: "status" },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 8, name: "rateRules", header: "Tarifario", filter: false },
  ]),
  withPermissions("transport-rate-rule", "Reglas tarifarias", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "ruleType", header: "Tipo regla", filter: true, format: "status" },
    { order: 4, name: "priority", header: "Prioridad", filter: true },
    { order: 5, name: "calculationType", header: "Cálculo", filter: true, format: "status" },
    { order: 6, name: "transportService", header: "Servicio", filter: true },
    { order: 7, name: "vehicleType", header: "Vehículo", filter: true },
    { order: 8, name: "validityStr", header: "Vigencia", filter: true },
    { order: 9, name: "stackable", header: "Apilable", filter: false, format: "bool" },
    { order: 10, name: "active", header: "Activo", filter: true, format: "bool" },
  ]),
  withPermissions("vehicle", "Vehículos", [
    { order: 1, name: "plate", header: "Placa", filter: true },
    { order: 2, name: "type", header: "Tipo", filter: true, format: "label" },
    { order: 3, name: "brand", header: "Marca", filter: true },
    { order: 4, name: "model", header: "Modelo", filter: true },
    { order: 5, name: "capacityKg", header: "Capacidad(Kg)", filter: true },
    { order: 6, name: "currentTripId", header: "Viaje actual", filter: true },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
  ]),
  withPermissions("driver", "Conductores", [
    { order: 2, name: "firstName", header: "Nombre", filter: true },
    { order: 3, name: "lastName", header: "Apellido", filter: true },
    { order: 4, name: "documentNo", header: "Nº Doc", filter: true },
    { order: 5, name: "documentType", header: "Tipo doc", filter: true },
    { order: 6, name: "phoneNo", header: "Teléfono", filter: true },
    { order: 7, name: "licenseNo", header: "Licencia", filter: true },
    { order: 8, name: "licenseCategory", header: "Categoría", filter: true },
    { order: 9, name: "licenseExpiration", header: "Venc. licencia", filter: true, format: "date" },
    { order: 10, name: "relationshipType", header: "Vínculo", filter: true, format: "label" },
    { order: 11, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 12, name: "currentTripId", header: "Viaje actual", filter: true },
  ]),
  withPermissions("plan", "Planes de transporte", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "date", header: "Fecha", filter: true },
    { order: 3, name: "zone", header: "Zona", filter: true },
    { order: 4, name: "vehicleType", header: "Tipo vehículo", filter: true },
    { order: 5, name: "orderIdsStr", header: "Pedidos", filter: true },
    { order: 6, name: "status", header: "Estado", filter: true, format: "status" },
  ]),
  withPermissions("route", "Rutas", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "planCodeDisplay", header: "Plan", filter: true },
    { order: 4, name: "totalEstimatedKm", header: "Km estimados", filter: true },
    { order: 5, name: "totalEstimatedHours", header: "Horas estimadas", filter: true },
    { order: 6, name: "active", header: "Activo", filter: true },
  ]),
  withPermissions("route-stop", "Paradas de ruta", [
    { order: 1, name: "orderId", header: "Pedido", filter: true },
    { order: 2, name: "sequence", header: "Secuencia", filter: true },
    { order: 3, name: "eta", header: "ETA", filter: true },
    { order: 4, name: "arrivalWindowStr", header: "Ventana", filter: true },
    { order: 5, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 6, name: "type", header: "Tipo", filter: true, format: "status" },
    { order: 7, name: "name", header: "Nombre", filter: true },
    { order: 8, name: "address", header: "Dirección", filter: true },
    { order: 9, name: "lat", header: "Lat", filter: true },
    { order: 10, name: "lng", header: "Lng", filter: true },
  ]),
  withPermissions("trip", "Viajes", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "routeDisplay", header: "Ruta", filter: true },
    { order: 3, name: "transportServiceDisplay", header: "Servicio", filter: true },
    { order: 4, name: "clientDisplay", header: "Cliente", filter: true },
    { order: 5, name: "transportGuide", header: "Guía", filter: true },
    { order: 6, name: "vehicle", header: "Vehículo", filter: true },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 8, name: "scheduledStart", header: "Inicio programado", filter: true, format: "datetime" },
    { order: 9, name: "tripStops", header: "Paradas", filter: false },
    { order: 10, name: "tripAssignments", header: "Asignaciones", filter: false },
    { order: 11, name: "tripCharges", header: "Cargos", filter: false },
    { order: 12, name: "tripCosts", header: "Costos", filter: false },
  ]),
  withPermissions("trip-stop", "Paradas de viaje", [
    { order: 1, name: "order", header: "Orden", filter: true },
    { order: 2, name: "code", header: "Código", filter: true },
    { order: 3, name: "type", header: "Tipo", filter: true, format: "status" },
    { order: 4, name: "name", header: "Nombre", filter: true },
    { order: 5, name: "externalDocument", header: "Documento externo", filter: true },
    { order: 6, name: "districtName", header: "Distrito", filter: true },
    { order: 7, name: "observations", header: "Observaciones", filter: true },
    { order: 8, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 9, name: "plannedArrival", header: "Llegada planificada", filter: true, format: "datetime" },
  ]),
  withPermissions("trip-assignment", "Asignaciones de viaje", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "assignmentTypeLabel", header: "Tipo asignación", filter: true },
    { order: 3, name: "displayName", header: "Nombre", filter: true },
    { order: 4, name: "entityType", header: "Tipo entidad", filter: true, format: "label" },
    { order: 5, name: "position", header: "Posición", filter: true },
    { order: 6, name: "scopeSummary", header: "Alcance", filter: true },
  ]),
  withPermissions("trip-charge", "Cargos de viaje", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "name", header: "Nombre", filter: true },
    { order: 3, name: "chargeTypeLabel", header: "Tipo", filter: true },
    { order: 4, name: "source", header: "Origen", filter: true, format: "label" },
    { order: 5, name: "amountFormatted", header: "Monto", filter: true },
    { order: 6, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 7, name: "settlement", header: "Liquidación", filter: true },
  ]),
  withPermissions("trip-cost", "Costos de viaje", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "chargeTypeLabel", header: "Tipo", filter: true },
    { order: 3, name: "displayName", header: "Nombre", filter: true },
    { order: 4, name: "source", header: "Origen", filter: true, format: "label" },
    { order: 5, name: "amountFormatted", header: "Monto", filter: true },
    { order: 6, name: "status", header: "Estado", filter: true, format: "status" },
  ]),
  withPermissions("settlement", "Liquidaciones", [
    { order: 1, name: "code", header: "Código", filter: true },
    { order: 2, name: "type", header: "Tipo", filter: true, format: "label" },
    { order: 3, name: "category", header: "Categoría", filter: true, format: "label" },
    { order: 4, name: "entityDisplay", header: "Entidad", filter: true },
    { order: 5, name: "periodLabel", header: "Periodo", filter: true },
    { order: 6, name: "grossFormatted", header: "Bruto", filter: true },
    { order: 7, name: "status", header: "Estado", filter: true, format: "status" },
    { order: 8, name: "paymentStatus", header: "Pago", filter: true, format: "status" },
    { order: 9, name: "itemsLink", header: "Ítems", filter: false },
  ]),
  withPermissions("settlement-item", "Ítems de liquidación", [
    { order: 1, name: "tripCode", header: "Viaje", filter: true },
    { order: 2, name: "tripRouteDisplay", header: "Ruta", filter: true },
    { order: 3, name: "tripStartDate", header: "Fecha", filter: true, format: "date" },
    { order: 4, name: "movementDisplay", header: "Tipo de movimiento", filter: true },
    { order: 5, name: "chargeType", header: "Tipo cargo", filter: true },
    { order: 6, name: "concept", header: "Concepto", filter: true },
    { order: 7, name: "amountFormatted", header: "Monto", filter: true },
    { order: 8, name: "settledFormatted", header: "Liquidado", filter: true },
    { order: 9, name: "pendingFormatted", header: "Pendiente", filter: true },
  ]),
  withPermissions("company-user", "Miembros por empresa", [
    { order: 1, name: "emailLabel", header: "Usuario", filter: true },
    { order: 2, name: "rolesLabel", header: "Roles", filter: true },
    { order: 3, name: "status", header: "Activo", filter: true, format: "status" },
  ]),
  withPermissions(
    "invoice",
    "Facturas",
    [
      { order: 1, name: "documentNo", header: "# Documento", filter: true },
      { order: 2, name: "operationTypeCode", header: "Tipo operación", filter: true, format: "label" },
      { order: 3, name: "type", header: "Tipo", filter: true, format: "label" },
      { order: 4, name: "clientName", header: "Cliente", filter: true },
      { order: 5, name: "issueDate", header: "F. Emisión", filter: true, format: "datetime" },
      { order: 6, name: "payTerm", header: "Cond. Pago", filter: true, format: "label" },
      { order: 7, name: "currency", header: "Moneda", filter: true, format: "label" },
      { order: 8, name: "totalPriceFormatted", header: "Subtotal", filter: true },
      { order: 9, name: "totalTaxFormatted", header: "Impuesto", filter: true },
      { order: 10, name: "totalFormatted", header: "Total", filter: true },
      { order: 11, name: "status", header: "Estado", filter: true, format: "status" },
      { order: 12, name: "issueBlockReason", header: "Bloqueo emisión", filter: true },
      { order: 13, name: "sunatDocs", header: "Docs SUNAT", filter: false },
      { order: 14, name: "invoiceItems", header: "Ítems", filter: false },
      { order: 15, name: "invoiceCredits", header: "Cuotas", filter: false },
      { order: 16, name: "settlement", header: "Liquidación", filter: true },
    ],
    INVOICE_PERMISSIONS
  ),
  withPermissions("invoice-item", "Ítems de factura", [
    { order: 1,  name: "itemName",        header: "Ítem",         filter: true },
    { order: 2,  name: "description",     header: "Descripción",  filter: true },
    { order: 3,  name: "itemType",        header: "Tipo",         filter: true, format: "status" },
    { order: 4,  name: "measureName",     header: "Unidad",       filter: true },
    { order: 5,  name: "taxTypeName",     header: "Impuesto",     filter: true },
    { order: 6,  name: "quantity",        header: "Cantidad",     filter: true },
    { order: 7,  name: "unitPrice",       header: "P. Unitario",  filter: true },
    { order: 8,  name: "priceFormatted",  header: "Subtotal",     filter: true },
    { order: 9,  name: "taxFormatted",    header: "IGV",          filter: true },
    { order: 10, name: "amountFormatted", header: "Total",        filter: true },
  ]),
  withPermissions("invoice-credit", "Cuotas de factura", [
    { order: 1, name: "correlative",     header: "Cuota",        filter: true },
    { order: 2, name: "dueDate",         header: "Vencimiento",  filter: true, format: "date" },
    { order: 3, name: "creditFormatted", header: "Monto",        filter: true },
  ]),
  withPermissions(
    "sunat-config",
    "Configuración SUNAT",
    [
      { order: 0, name: "name", header: "Nombre", filter: true },
      { order: 1, name: "active", header: "Activo", filter: true, format: "bool" },
      { order: 2, name: "environmentLabel", header: "Ambiente", filter: true },
      { order: 3, name: "usuarioSunat", header: "Usuario SOL", filter: true },
    ],
    [
      { code: "view", label: "Ver", description: "Permite consultar la configuración SUNAT de la empresa." },
      { code: "edit", label: "Editar", description: "Permite guardar credenciales y certificados SUNAT." },
    ]
  ),
  withPermissions(
    "sunat-monitor",
    "Monitor de envíos a SUNAT",
    [
      { order: 1, name: "documentNo", header: "# Documento", filter: true },
      { order: 2, name: "docType", header: "Tipo doc", filter: true, format: "label" },
      { order: 3, name: "jobType", header: "Tipo envío", filter: true, format: "label" },
      { order: 4, name: "createdAtLabel", header: "Enviado", filter: true },
      { order: 5, name: "status", header: "Estado", filter: true, format: "status" },
      { order: 6, name: "sunatDocs", header: "Docs", filter: false },
      { order: 7, name: "errorMessage", header: "Error", filter: true },
      { order: 8, name: "actions", header: "Acciones", filter: false },
    ],
    [
      { code: "view", label: "Ver", description: "Permite consultar el monitor de envíos a SUNAT." },
      { code: "run", label: "Reenviar", description: "Permite reenviar documentos a SUNAT desde el monitor." },
    ]
  ),
];

export function getWebModuleById(id: string): ModuleRecord | null {
  const match = WEB_MODULES_CATALOG.find((m) => m.id === id);
  return match ? { ...match, permissions: [...match.permissions], columns: [...match.columns] } : null;
}

export function getWebModules(): ModuleRecord[] {
  return WEB_MODULES_CATALOG
    .map((m) => ({ ...m, permissions: [...m.permissions], columns: [...m.columns] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

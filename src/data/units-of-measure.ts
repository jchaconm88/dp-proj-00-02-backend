/** Códigos canónicos de unidad (catálogo estático, alineado a la Web previa). */
export type UnitOfMeasureCode = "unit" | "kg" | "lt" | "m" | "box";

export interface UnitOfMeasureCatalogRecord {
  /** Igual que `code` para catálogo versionado en código. */
  id: UnitOfMeasureCode;
  code: UnitOfMeasureCode;
  name: string;
  abbreviation: string;
  sunatCode: string;
  sunatName: string;
  readonly: true;
}

const UNITS_CATALOG: UnitOfMeasureCatalogRecord[] = [
  {
    id: "unit",
    code: "unit",
    name: "Unidad",
    abbreviation: "Uni.",
    sunatCode: "NIU",
    sunatName: "Unidad",
    readonly: true,
  },
  {
    id: "kg",
    code: "kg",
    name: "Kilogramo",
    abbreviation: "Kg.",
    sunatCode: "KGM",
    sunatName: "Kilogramo",
    readonly: true,
  },
  {
    id: "lt",
    code: "lt",
    name: "Litro",
    abbreviation: "Lt.",
    sunatCode: "LTR",
    sunatName: "Litro",
    readonly: true,
  },
  {
    id: "m",
    code: "m",
    name: "Metro",
    abbreviation: "m.",
    sunatCode: "MTR",
    sunatName: "Metro",
    readonly: true,
  },
  {
    id: "box",
    code: "box",
    name: "Caja",
    abbreviation: "Cj.",
    sunatCode: "NIU",
    sunatName: "Caja",
    readonly: true,
  },
];

function cloneUnit(row: UnitOfMeasureCatalogRecord): UnitOfMeasureCatalogRecord {
  return { ...row };
}

export function getUnitsOfMeasureCatalog(): UnitOfMeasureCatalogRecord[] {
  return UNITS_CATALOG.map(cloneUnit).sort((a, b) => a.code.localeCompare(b.code));
}

export function parseUnitOfMeasureCode(raw: unknown): UnitOfMeasureCode | null {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "unit") return "unit";
  if (normalized === "kg") return "kg";
  if (normalized === "lt") return "lt";
  if (normalized === "m") return "m";
  if (normalized === "box") return "box";
  return null;
}

export function getUnitOfMeasureByIdOrCode(raw: unknown): UnitOfMeasureCatalogRecord | null {
  const code = parseUnitOfMeasureCode(raw);
  if (!code) return null;
  const row = UNITS_CATALOG.find((u) => u.code === code);
  return row ? cloneUnit(row) : null;
}

/** Campos de unidad a persistir en Firestore (sin undefined). Incluye SUNAT para facturación sin lookup extra. */
export function unitDenormalizedFirestoreFields(row: UnitOfMeasureCatalogRecord): Record<string, string> {
  return {
    unitOfMeasureId: row.id,
    unitOfMeasureCode: row.code,
    unitOfMeasureName: row.name,
    unitOfMeasureAbbreviation: row.abbreviation,
    unitOfMeasureSunatCode: row.sunatCode,
    unitOfMeasureSunatName: row.sunatName,
  };
}

/**
 * Resuelve la unidad desde el cuerpo HTTP: `unitOfMeasureCode`, `unitOfMeasureId` o legacy `unitOfMeasure` (solo si coincide con un código del catálogo).
 */
export function resolveUnitOfMeasureFromBody(body: Record<string, unknown>): UnitOfMeasureCatalogRecord | null {
  const raw = body.unitOfMeasureCode ?? body.unitOfMeasureId ?? body.unitOfMeasure;
  return getUnitOfMeasureByIdOrCode(raw);
}

/**
 * Campos de unidad para respuestas API / lectura: desde documento denormalizado o legacy `unitOfMeasure`.
 */
export function unitFieldsForApiResponse(d: Record<string, unknown>): {
  unitOfMeasureId: string;
  unitOfMeasureCode: string;
  unitOfMeasureName: string;
  unitOfMeasureAbbreviation: string;
  unitOfMeasureSunatCode: string;
  unitOfMeasureSunatName: string;
} {
  const code = String(d.unitOfMeasureCode ?? "").trim();
  if (code) {
    const rowFromCode = getUnitOfMeasureByIdOrCode(code);
    let sunatCode = String(d.unitOfMeasureSunatCode ?? "").trim();
    let sunatName = String(d.unitOfMeasureSunatName ?? "").trim();
    let abbrev = String(d.unitOfMeasureAbbreviation ?? "").trim();
    let name = String(d.unitOfMeasureName ?? "").trim();
    if (rowFromCode) {
      if (!sunatCode || !sunatName) {
        sunatCode = rowFromCode.sunatCode;
        sunatName = rowFromCode.sunatName;
      }
      if (!abbrev) abbrev = rowFromCode.abbreviation;
      if (!name) name = rowFromCode.name;
    }
    return {
      unitOfMeasureId: String(d.unitOfMeasureId ?? code),
      unitOfMeasureCode: code,
      unitOfMeasureName: name,
      unitOfMeasureAbbreviation: abbrev,
      unitOfMeasureSunatCode: sunatCode,
      unitOfMeasureSunatName: sunatName,
    };
  }
  const row = getUnitOfMeasureByIdOrCode(d.unitOfMeasure ?? d.unitOfMeasureId);
  if (row) {
    return {
      unitOfMeasureId: row.id,
      unitOfMeasureCode: row.code,
      unitOfMeasureName: row.name,
      unitOfMeasureAbbreviation: row.abbreviation,
      unitOfMeasureSunatCode: row.sunatCode,
      unitOfMeasureSunatName: row.sunatName,
    };
  }
  const legacy = String(d.unitOfMeasure ?? "").trim();
  return {
    unitOfMeasureId: "",
    unitOfMeasureCode: legacy,
    unitOfMeasureName: legacy,
    unitOfMeasureAbbreviation: legacy,
    unitOfMeasureSunatCode: "",
    unitOfMeasureSunatName: "",
  };
}

import type { Firestore } from "firebase-admin/firestore";

export const VARIANT_ATTRIBUTE_TYPE_CODE_RE = /^[a-z0-9_-]+$/;

export interface VariantAttributeTypeRow {
  id: string;
  code: string;
  label: string;
  values: string[];
  sortOrder: number;
  active: boolean;
}

export function normalizeVariantTypeCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeVariantTypeValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const v = String(item ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function parseVariantAttributeTypeCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const code = normalizeVariantTypeCode(item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function normalizeAttributesInput(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = normalizeVariantTypeCode(key);
    const value = String(val ?? "").trim();
    if (!code || !value) continue;
    out[code] = value;
  }
  return out;
}

export async function loadVariantAttributeTypesByCode(
  db: Firestore,
  companyId: string,
  accountId: string
): Promise<Map<string, VariantAttributeTypeRow>> {
  const snap = await db
    .collection("variant-attribute-types")
    .where("companyId", "==", companyId)
    .where("accountId", "==", accountId)
    .get();
  const map = new Map<string, VariantAttributeTypeRow>();
  for (const doc of snap.docs) {
    const d = doc.data() ?? {};
    const code = normalizeVariantTypeCode(d.code);
    if (!code) continue;
    map.set(code, {
      id: doc.id,
      code,
      label: String(d.label ?? code),
      values: normalizeVariantTypeValues(d.values),
      sortOrder: Number(d.sortOrder) || 0,
      active: d.active !== false,
    });
  }
  return map;
}

export function validateVariantAttributeTypeCodes(
  codes: string[],
  catalog: Map<string, VariantAttributeTypeRow>
): string | null {
  for (const code of codes) {
    if (!VARIANT_ATTRIBUTE_TYPE_CODE_RE.test(code)) {
      return `Código de tipo inválido: "${code}"`;
    }
    const row = catalog.get(code);
    if (!row) return `Tipo de variante "${code}" no existe en el catálogo`;
    if (!row.active) return `Tipo de variante "${code}" no está activo`;
  }
  return null;
}

export function buildAttributeDefinitions(
  codes: string[],
  catalog: Map<string, VariantAttributeTypeRow>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const code of codes) {
    const row = catalog.get(code);
    if (row) out[code] = [...row.values];
  }
  return out;
}

/** Etiquetas legibles por código (p. ej. vt-0001 → Color) para integración sin releer catálogo. */
export function buildVariantAttributeLabels(
  codes: string[],
  catalog: Map<string, VariantAttributeTypeRow>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of codes) {
    const row = catalog.get(code);
    out[code] = row?.label?.trim() || code;
  }
  return out;
}

export function parseVariantAttributeLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = normalizeVariantTypeCode(key);
    const label = String(val ?? "").trim();
    if (!code || !label) continue;
    out[code] = label;
  }
  return out;
}

export function validateVariantAttributes(
  attributes: Record<string, string>,
  productTypeCodes: string[],
  catalog: Map<string, VariantAttributeTypeRow>
): string | null {
  const allowed = new Set(productTypeCodes);
  for (const [code, value] of Object.entries(attributes)) {
    if (!allowed.has(code)) {
      return `El atributo "${code}" no está configurado en el producto padre`;
    }
    const row = catalog.get(code);
    if (!row) return `Tipo de variante "${code}" no existe`;
    if (!row.active) return `Tipo de variante "${code}" no está activo`;
    if (row.values.length > 0 && !row.values.includes(value)) {
      return `Valor "${value}" no permitido para "${row.label}"`;
    }
  }
  return null;
}

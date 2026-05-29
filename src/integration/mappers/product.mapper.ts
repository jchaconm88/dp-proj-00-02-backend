export interface ProductResponse {
  sku: string;
  name: string;
  description?: string;
  category_path: string[];
  ecommerce_status: string;
  sale_price: number;
  sale_price_promo?: number | null;
  currency: string;
  images: string[];
  /** Valores permitidos por código de tipo */
  attribute_definitions: Record<string, string[]>;
  /** Etiqueta legible por código (p. ej. vt-0001 → Color) */
  attribute_labels: Record<string, string>;
  variants: ProductVariantResponse[];
  updated_at: string;
}

export interface ProductVariantResponse {
  sku: string;
  /** Clave = código de tipo, valor = opción elegida */
  attributes: Record<string, string>;
  sale_price: number;
  sale_price_promo?: number | null;
  weight_kg?: number;
  images: string[];
  active: boolean;
}

function normalizeAttributeDefinitions(data: Record<string, unknown>): Record<string, string[]> {
  const raw = data.attributeDefinitions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key).trim().toLowerCase();
    if (!code) continue;
    out[code] = Array.isArray(val) ? val.map(String) : [];
  }
  return out;
}

function normalizeVariantAttributeLabels(data: Record<string, unknown>): Record<string, string> {
  const raw = data.variantAttributeLabels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key).trim().toLowerCase();
    const label = String(val ?? "").trim();
    if (!code || !label) continue;
    out[code] = label;
  }
  return out;
}

function normalizeVariantAttributes(data: Record<string, unknown>): Record<string, string> {
  const raw = data.attributes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key).trim().toLowerCase();
    const value = String(val ?? "").trim();
    if (!code || !value) continue;
    out[code] = value;
  }
  return out;
}

export function toProductResponse(data: Record<string, unknown>, variants: Record<string, unknown>[]): ProductResponse {
  const attribute_definitions = normalizeAttributeDefinitions(data);
  const attribute_labels = normalizeVariantAttributeLabels(data);
  const typeCodes = Object.keys(attribute_definitions);
  for (const code of typeCodes) {
    if (!attribute_labels[code]) attribute_labels[code] = code;
  }

  return {
    sku: String(data.sku ?? ""),
    name: String(data.name ?? ""),
    description: data.description ? String(data.description) : undefined,
    category_path: Array.isArray(data.categoryPath) ? data.categoryPath.map(String) : [],
    ecommerce_status: String(data.ecommerceStatus ?? "active"),
    sale_price: Number(data.salePrice ?? 0),
    sale_price_promo: data.salePricePromo != null ? Number(data.salePricePromo) : null,
    currency: String(data.currency ?? "PEN"),
    images: Array.isArray(data.imageUrls) ? data.imageUrls.map(String) : [],
    attribute_definitions,
    attribute_labels,
    variants: variants.map(toVariantResponse),
    updated_at: String(data.updatedAt ?? data.updateAt ?? new Date().toISOString()),
  };
}

export function toVariantResponse(data: Record<string, unknown>): ProductVariantResponse {
  return {
    sku: String(data.sku ?? ""),
    attributes: normalizeVariantAttributes(data),
    sale_price: Number(data.salePrice ?? 0),
    sale_price_promo: data.salePricePromo != null ? Number(data.salePricePromo) : null,
    weight_kg: data.weightKg ? Number(data.weightKg) : undefined,
    images: Array.isArray(data.imageUrls) ? data.imageUrls.map(String) : [],
    active: data.active !== false,
  };
}

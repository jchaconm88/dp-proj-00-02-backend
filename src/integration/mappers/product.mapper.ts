export interface ProductResponse {
  sku: string;
  name: string;
  description?: string;
  category_path: string[];
  ecommerce_status: string;
  wc_product_type: string;
  tags: string[];
  visible_in_store: boolean;
  sale_price: number;
  sale_price_promo?: number | null;
  currency: string;
  images: string[];
  stock_quantity?: number;
  manage_stock?: boolean;
  grouped_product_skus?: string[];
  /** Valores permitidos por código de tipo (variación) */
  attribute_definitions: Record<string, string[]>;
  /** Etiqueta legible por código (p. ej. vt-0001 → Color) */
  attribute_labels: Record<string, string>;
  /** Atributos filtrables: código → valores asignados */
  filterable_attributes: Record<string, string[]>;
  /** Etiquetas de atributos filtrables: código → label legible */
  filterable_attribute_labels: Record<string, string>;
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
  stock_quantity?: number;
  manage_stock?: boolean;
}

export function normalizeFilterableAttributes(data: Record<string, unknown>): Record<string, string[]> {
  const raw = data.filterableAttributes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key).trim().toLowerCase();
    if (!code) continue;
    let values: string[];
    if (Array.isArray(val)) {
      values = val.map(String).filter(v => v.trim() !== "");
    } else if (val && typeof val === "string" && val.trim() !== "") {
      values = [val];
    } else {
      continue;
    }
    if (values.length === 0) continue;
    out[code] = values;
  }
  return out;
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

export function normalizeFilterableAttributeLabels(
  data: Record<string, unknown>,
  filterableAttributes: Record<string, string[]>
): Record<string, string> {
  const raw = data.filterableAttributeLabels;
  const out: Record<string, string> = {};
  const labelsMap = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  for (const code of Object.keys(filterableAttributes)) {
    const label = String(labelsMap[code] ?? "").trim();
    out[code] = label || code; // fallback to code if no label
  }
  return out;
}

export async function toProductResponse(data: Record<string, unknown>, variants: Record<string, unknown>[], db?: any): Promise<ProductResponse> {
  const attribute_definitions = normalizeAttributeDefinitions(data);
  const attribute_labels = normalizeVariantAttributeLabels(data);
  const typeCodes = Object.keys(attribute_definitions);
  for (const code of typeCodes) {
    if (!attribute_labels[code]) attribute_labels[code] = code;
  }

  const filterable_attributes = normalizeFilterableAttributes(data);
  const filterable_attribute_labels = normalizeFilterableAttributeLabels(data, filterable_attributes);

  const stock_quantity: number | undefined = undefined;
  const manage_stock: boolean | undefined = stock_quantity !== undefined ? true : undefined;

  let grouped_product_skus: string[] | undefined;
  if (data.woocommerceType === "grouped" && Array.isArray(data.groupedProductIds) && data.groupedProductIds.length > 0 && db) {
    const ids = data.groupedProductIds as string[];
    const skus: string[] = [];
    for (const id of ids) {
      const doc = await db.collection("products").doc(id).get();
      if (doc.exists) {
        const sku = String(doc.data()?.sku ?? "");
        if (sku) skus.push(sku);
      }
    }
    grouped_product_skus = skus.length > 0 ? skus : undefined;
  }

  return {
    sku: String(data.sku ?? ""),
    name: String(data.name ?? ""),
    description: data.description ? String(data.description) : undefined,
    category_path: Array.isArray(data.categoryPath) ? data.categoryPath.map(String) : [],
    ecommerce_status: String(data.ecommerceStatus ?? "active"),
    wc_product_type: String(data.woocommerceType ?? "simple"),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    visible_in_store: data.visibleInStore !== false,
    stock_quantity,
    manage_stock,
    sale_price: Number(data.salePrice ?? 0),
    sale_price_promo: data.salePricePromo != null ? Number(data.salePricePromo) : null,
    currency: String(data.currency ?? "PEN"),
    images: Array.isArray(data.imageUrls) ? data.imageUrls.map(String) : [],
    grouped_product_skus,
    attribute_definitions,
    attribute_labels,
    filterable_attributes,
    filterable_attribute_labels,
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
    stock_quantity: undefined,
    manage_stock: undefined,
  };
}

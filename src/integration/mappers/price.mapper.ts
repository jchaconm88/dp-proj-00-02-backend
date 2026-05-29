export interface PriceResponse {
  sku: string;
  sale_price: number;
  sale_price_promo?: number | null;
  currency: string;
  price_list: string;
  updated_at: string;
}

export function toPriceResponse(data: Record<string, unknown>): PriceResponse {
  return {
    sku: String(data.sku ?? ""),
    sale_price: Number(data.salePrice ?? 0),
    sale_price_promo: data.salePricePromo != null ? Number(data.salePricePromo) : null,
    currency: String(data.currency ?? "PEN"),
    price_list: String(data.priceListCode ?? "web"),
    updated_at: String(data.updatedAt ?? new Date().toISOString()),
  };
}

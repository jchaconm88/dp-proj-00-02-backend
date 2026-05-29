export interface StockLevelResponse {
  sku: string;
  stock_quantity: number;
  reserved: number;
  available: number;
  warehouse: string;
  updated_at: string;
}

export function toStockResponse(data: Record<string, unknown>): StockLevelResponse {
  return {
    sku: String(data.sku ?? ""),
    stock_quantity: Number(data.quantity ?? 0),
    reserved: Number(data.reserved ?? 0),
    available: Number(data.available ?? 0),
    warehouse: String(data.warehouseCode ?? ""),
    updated_at: String(data.updatedAt ?? new Date().toISOString()),
  };
}

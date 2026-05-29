export interface OrderCreateInput {
  channel: string;
  external_id: string;
  customer_external_id?: string;
  items: OrderItemInput[];
  notes?: string;
  created_at?: string;
}

export interface OrderItemInput {
  sku: string;
  quantity: number;
  unit_price: number;
}

export interface OrderCreateResponse {
  erp_order_id: string;
  status: string;
  created_at: string;
}

export function toOrderCreateResponse(orderId: string, createdAt: string): OrderCreateResponse {
  return {
    erp_order_id: orderId,
    status: "received",
    created_at: createdAt,
  };
}

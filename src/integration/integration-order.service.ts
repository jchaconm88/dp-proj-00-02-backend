import { getWebFirestore } from "../lib/firebase-admin.js";
import { getDocumentTypesByCountryAndType } from "../data/document-types.js";
import { emit } from "./integration-events.js";
import { toOrderCreateResponse } from "./mappers/order.mapper.js";
import { processOutbox } from "./integration-webhook.dispatcher.js";

function norm(value: unknown): string {
  return String(value ?? "").trim();
}

function normFs(value: unknown): string {
  return norm(value);
}

export interface IntegrationRequestContext {
  companyId: string;
  accountId: string;
  credentialId: string;
}

export async function getCredentialWarehouse(
  db: FirebaseFirestore.Firestore,
  credentialId: string
): Promise<{ warehouseId: string; warehouseName: string; warehouseCode: string }> {
  const credSnap = await db.collection("integration-credentials").doc(credentialId).get();
  const code = norm(credSnap.data()?.defaultWarehouseCode) || "MAIN";
  const whSnap = await db
    .collection("warehouses")
    .where("companyId", "==", norm(credSnap.data()?.companyId))
    .where("code", "==", code)
    .limit(1)
    .get();
  if (!whSnap.empty) {
    const d = whSnap.docs[0]!.data();
    return {
      warehouseId: whSnap.docs[0]!.id,
      warehouseName: norm(d.name) || code,
      warehouseCode: code,
    };
  }
  const fallback = await db.collection("warehouses").limit(1).get();
  if (!fallback.empty) {
    const d = fallback.docs[0]!.data();
    return {
      warehouseId: fallback.docs[0]!.id,
      warehouseName: norm(d.name) || "Almacén",
      warehouseCode: norm(d.code) || code,
    };
  }
  return { warehouseId: "default", warehouseName: code, warehouseCode: code };
}

export async function resolveSku(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  sku: string
): Promise<{ productId: string; variantId?: string; productName: string; productCode: string } | null> {
  const skuNorm = norm(sku);
  if (!skuNorm) return null;

  const variantSnap = await db
    .collectionGroup("variants")
    .where("companyId", "==", companyId)
    .where("sku", "==", skuNorm)
    .limit(1)
    .get();
  if (!variantSnap.empty) {
    const v = variantSnap.docs[0]!;
    const vd = v.data();
    const productId = norm(vd.productId) || v.ref.parent.parent?.id || "";
    if (!productId) return null;
    const productDoc = await db.collection("products").doc(productId).get();
    const pd = productDoc.data() ?? {};
    return {
      productId,
      variantId: v.id,
      productName: norm(vd.name) || norm(pd.name) || skuNorm,
      productCode: norm(pd.code) || skuNorm,
    };
  }

  const productSnap = await db
    .collection("products")
    .where("companyId", "==", companyId)
    .where("sku", "==", skuNorm)
    .limit(1)
    .get();
  if (!productSnap.empty) {
    const doc = productSnap.docs[0]!;
    const pd = doc.data();
    return {
      productId: doc.id,
      productName: norm(pd.name) || skuNorm,
      productCode: norm(pd.code) || skuNorm,
    };
  }

  const codeSnap = await db
    .collection("products")
    .where("companyId", "==", companyId)
    .where("code", "==", skuNorm)
    .limit(1)
    .get();
  if (!codeSnap.empty) {
    const doc = codeSnap.docs[0]!;
    const pd = doc.data();
    return {
      productId: doc.id,
      productName: norm(pd.name) || skuNorm,
      productCode: norm(pd.code) || skuNorm,
    };
  }

  return null;
}

async function findClientByExternal(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  externalId: string,
  email: string
): Promise<string | null> {
  if (externalId) {
    const snap = await db
      .collection("clients")
      .where("companyId", "==", companyId)
      .where("externalIds.woocommerce", "==", externalId)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0]!.id;
  }
  if (email) {
    const all = await db.collection("clients").where("companyId", "==", companyId).limit(200).get();
    for (const doc of all.docs) {
      const contact = (doc.data().contact ?? {}) as Record<string, unknown>;
      if (norm(contact.email).toLowerCase() === email.toLowerCase()) return doc.id;
    }
  }
  return null;
}

export async function upsertIntegrationCustomer(
  ctx: IntegrationRequestContext,
  body: Record<string, unknown>
): Promise<{ clientId: string; created: boolean }> {
  const db = getWebFirestore();
  const externalId = norm(body.external_id);
  const name = norm(body.name);
  const email = norm(body.email);
  const customerBlock = body.customer && typeof body.customer === "object" ? (body.customer as Record<string, unknown>) : {};
  const extFromCustomer = norm(customerBlock.external_id) || externalId;
  const emailFromCustomer = norm(customerBlock.email) || email;
  const displayName =
    name ||
    [norm(customerBlock.first_name), norm(customerBlock.last_name)].filter(Boolean).join(" ") ||
    emailFromCustomer ||
    `Cliente ${extFromCustomer}`;

  const existingId = await findClientByExternal(db, ctx.companyId, extFromCustomer, emailFromCustomer);
  if (existingId) {
    const cur = (await db.collection("clients").doc(existingId).get()).data() ?? {};
    const prevExt = (cur.externalIds ?? {}) as Record<string, string>;
    const patch: Record<string, unknown> = {
      updatedAt: new Date(),
      externalIds: extFromCustomer ? { ...prevExt, woocommerce: extFromCustomer } : prevExt,
    };
    await db.collection("clients").doc(existingId).update(patch);
    return { clientId: existingId, created: false };
  }

  const docTypes = getDocumentTypesByCountryAndType("PE", "identity");
  const docType = docTypes[0] ?? { id: "DNI", name: "DNI" };
  const now = new Date();
  const docRef = db.collection("clients").doc();
  await docRef.set({
    companyId: ctx.companyId,
    accountId: ctx.accountId,
    code: extFromCustomer ? `WC-${extFromCustomer}` : `WC-${docRef.id.slice(0, 8)}`,
    businessName: displayName,
    commercialName: normFs(customerBlock.company),
    documentTypeId: docType.id,
    documentType: docType.name,
    documentNumber: normFs(body.document_number) || normFs(body.documentNumber) || "00000000",
    contact: {
      contactName: displayName,
      email: emailFromCustomer,
      phone: norm(customerBlock.phone) || norm(body.phone),
    },
    billing: {
      creditDays: 0,
      creditLimit: 0,
      currency: norm(body.currency) || "PEN",
      paymentCondition: "transfer",
    },
    logistics: { priority: 0, requiresAppointment: false, defaultServiceTimeMin: 0 },
    status: "active",
    externalIds: extFromCustomer ? { woocommerce: extFromCustomer } : {},
    createdAt: now,
    updatedAt: now,
  });
  return { clientId: docRef.id, created: true };
}

function mapWcStatusToErp(wcStatus: string): string {
  const s = wcStatus.toLowerCase();
  if (s === "completed") return "delivered";
  if (s === "cancelled" || s === "refunded" || s === "failed") return "cancelled";
  if (s === "processing" || s === "on-hold" || s === "pending") return "confirmed";
  return "confirmed";
}

export async function createIntegrationOrder(
  ctx: IntegrationRequestContext,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getWebFirestore();
  const channel = norm(body.channel) || "woocommerce";
  const externalId = norm(body.external_id) || norm(body.externalId);
  if (!externalId) {
    return { status: 422, body: { type: "validation", title: "Validation failed", status: 422, detail: "external_id is required" } };
  }

  const dupSnap = await db
    .collection("sale-orders")
    .where("companyId", "==", ctx.companyId)
    .where("channel", "==", channel)
    .where("externalId", "==", externalId)
    .limit(1)
    .get();
  if (!dupSnap.empty) {
    const existing = dupSnap.docs[0]!;
    return {
      status: 409,
      body: {
        type: "conflict",
        title: "Order already exists",
        status: 409,
        detail: "Duplicate external_id for channel",
        erp_order_id: existing.id,
        existing_order: toOrderCreateResponse(existing.id, String(existing.data()?.createAt ?? new Date().toISOString())),
      },
    };
  }

  const { clientId } = await upsertIntegrationCustomer(ctx, body);
  const clientSnap = await db.collection("clients").doc(clientId).get();
  const clientData = clientSnap.data() ?? {};
  const clientName = norm(clientData.businessName) || norm(clientData.commercialName) || "Cliente";

  const itemsRaw = Array.isArray(body.items) ? body.items : [];
  if (itemsRaw.length === 0) {
    return { status: 422, body: { type: "validation", title: "Validation failed", status: 422, detail: "items array is required" } };
  }

  const { warehouseId, warehouseName, warehouseCode } = await getCredentialWarehouse(db, ctx.credentialId);
  const companySnap = await db.collection("companies").doc(ctx.companyId).get();
  const defaultCurrency = norm(companySnap.data()?.defaultCurrency) || "PEN";
  const currency = norm(body.currency) || defaultCurrency;

  const totals = body.totals && typeof body.totals === "object" ? (body.totals as Record<string, unknown>) : {};
  let subtotal = Number(totals.subtotal) || 0;
  let taxAmount = Number(totals.tax) || 0;
  let total = Number(totals.total) || 0;

  const resolvedLines: Array<{
    productId: string;
    variantId?: string;
    productName: string;
    productCode: string;
    sku: string;
    quantity: number;
    unitPrice: number;
    lineSubtotal: number;
    lineTax: number;
    lineTotal: number;
  }> = [];

  for (const raw of itemsRaw) {
    const row = raw as Record<string, unknown>;
    const sku = norm(row.sku);
    const qty = Number(row.quantity) || 0;
    if (!sku || qty <= 0) continue;
    const resolved = await resolveSku(db, ctx.companyId, sku);
    if (!resolved) {
      return { status: 422, body: { type: "validation", title: "Validation failed", status: 422, detail: `SKU not found: ${sku}` } };
    }
    const unitPrice = Number(row.unit_price ?? row.unitPrice) || 0;
    const lineTotal = Number(row.total) || unitPrice * qty;
    const lineTax = Number(row.tax) || 0;
    const lineSubtotal = lineTotal - lineTax;
    resolvedLines.push({
      ...resolved,
      sku,
      quantity: qty,
      unitPrice,
      lineSubtotal,
      lineTax,
      lineTotal,
    });
  }

  if (resolvedLines.length === 0) {
    return { status: 422, body: { type: "validation", title: "Validation failed", status: 422, detail: "No valid line items" } };
  }

  if (!subtotal) subtotal = resolvedLines.reduce((s, l) => s + l.lineSubtotal, 0);
  if (!taxAmount) taxAmount = resolvedLines.reduce((s, l) => s + l.lineTax, 0);
  if (!total) total = resolvedLines.reduce((s, l) => s + l.lineTotal, 0);

  const wcCustomerExt = norm(body.customer_external_id) || norm((body.customer as Record<string, unknown>)?.external_id);
  const erpStatus = mapWcStatusToErp(norm(body.status));
  const now = new Date();
  const orderRef = db.collection("sale-orders").doc();
  const orderCode = `WC-${externalId}`;

  await db.runTransaction(async (tx) => {
    for (const line of resolvedLines) {
      const stockId = `${line.productId}_${warehouseId}`;
      const stockRef = db.collection("stock-levels").doc(stockId);
      const stockSnap = await tx.get(stockRef);
      const qty = Number(stockSnap.data()?.quantity ?? 0);
      const reserved = Number(stockSnap.data()?.reserved ?? 0);
      const available = qty - reserved;
      if (available < line.quantity) {
        throw new Error(`insufficient_stock:${line.sku}`);
      }
      const newReserved = reserved + line.quantity;
      const patch = {
        productId: line.productId,
        variantId: line.variantId ?? "",
        sku: line.sku,
        warehouseId,
        warehouseName,
        warehouseCode,
        quantity: qty,
        reserved: newReserved,
        available: qty - newReserved,
        companyId: ctx.companyId,
        accountId: ctx.accountId,
        updatedAt: now,
      };
      if (stockSnap.exists) tx.update(stockRef, patch);
      else tx.set(stockRef, { ...patch, lastMovementDate: now.toISOString().slice(0, 10) });
    }

    tx.set(orderRef, {
      companyId: ctx.companyId,
      accountId: ctx.accountId,
      code: orderCode,
      clientId,
      clientName,
      issueDate: norm(body.created_at)?.slice(0, 10) || now.toISOString().slice(0, 10),
      currency,
      subtotal,
      taxAmount,
      total,
      notes: normFs(body.notes),
      status: erpStatus,
      locationId: "",
      locationName: "",
      channel,
      externalId,
      paymentStatus: norm((body.payment as Record<string, unknown>)?.method) ? "pending" : "unknown",
      wcCustomerExternalId: wcCustomerExt,
      integrationSyncStatus: "synced",
      integrationLastError: "",
      shipmentCarrier: "",
      shipmentTrackingNumber: "",
      shipmentTrackingUrl: "",
      shipmentStatus: "",
      invoiceId: "",
      createAt: now,
      createBy: "integration",
      updateAt: now,
      updateBy: "integration",
      integrationPayload: {
        shipping: body.shipping ?? null,
        payment: body.payment ?? null,
      },
    });

    for (const line of resolvedLines) {
      const itemRef = orderRef.collection("sale-order-items").doc();
      tx.set(itemRef, {
        productId: line.productId,
        variantId: line.variantId ?? "",
        sku: line.sku,
        productName: line.productName,
        productCode: line.productCode,
        quantity: line.quantity,
        unitOfMeasureCode: "NIU",
        unitOfMeasureName: "Unidad",
        unitPrice: line.unitPrice,
        discount: 0,
        taxAffectation: "10",
        subtotal: line.lineSubtotal,
        taxAmount: line.lineTax,
        total: line.lineTotal,
        dispatchedQuantity: 0,
      });
    }
  });

  const createdAt = now.toISOString();
  for (const line of resolvedLines) {
    emit({
      companyId: ctx.companyId,
      accountId: ctx.accountId,
      type: "stock_updated",
      payload: { sku: line.sku, productId: line.productId, warehouse: warehouseCode, quantity_delta: -line.quantity, updatedAt: createdAt },
    }).catch(() => {});
  }

  emit({
    companyId: ctx.companyId,
    accountId: ctx.accountId,
    type: "order_status_changed",
    payload: { orderId: orderRef.id, externalId, status: erpStatus, previousStatus: "", updatedAt: createdAt },
  }).catch(() => {});

  setImmediate(() => { processOutbox().catch(() => {}); });

  return {
    status: 201,
    body: toOrderCreateResponse(orderRef.id, createdAt) as unknown as Record<string, unknown>,
  };
}

export async function updateIntegrationOrderStatus(
  ctx: IntegrationRequestContext,
  orderId: string,
  status: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getWebFirestore();
  const snap = await db.collection("sale-orders").doc(orderId).get();
  if (!snap.exists) return { status: 404, body: { status: 404, detail: "Order not found" } };
  const data = snap.data() ?? {};
  if (norm(data.companyId) !== ctx.companyId) return { status: 403, body: { status: 403, detail: "Forbidden" } };

  const newStatus = mapWcStatusToErp(status) || norm(status) || "confirmed";
  const oldStatus = norm(data.status);
  const now = new Date();
  await db.collection("sale-orders").doc(orderId).update({ status: newStatus, updateAt: now, updateBy: "integration" });

  if (newStatus !== oldStatus) {
    emit({
      companyId: ctx.companyId,
      accountId: ctx.accountId,
      type: "order_status_changed",
      payload: {
        orderId,
        externalId: norm(data.externalId),
        status: newStatus,
        previousStatus: oldStatus,
        updatedAt: now.toISOString(),
      },
    }).catch(() => {});
    setImmediate(() => { processOutbox().catch(() => {}); });
  }

  return { status: 200, body: { ok: true, order_id: orderId, status: newStatus } };
}

export async function registerIntegrationPayment(
  ctx: IntegrationRequestContext,
  orderId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getWebFirestore();
  const snap = await db.collection("sale-orders").doc(orderId).get();
  if (!snap.exists) return { status: 404, body: { status: 404, detail: "Order not found" } };
  const data = snap.data() ?? {};
  if (norm(data.companyId) !== ctx.companyId) return { status: 403, body: { status: 403, detail: "Forbidden" } };

  const amount = Number(body.amount) || Number(data.total) || 0;
  const method = norm(body.method) || norm(body.method_title) || "unknown";
  const transactionId = norm(body.transaction_id) || norm(body.transactionId);

  await db.collection("sale-orders").doc(orderId).update({
    paymentStatus: "paid",
    integrationSyncStatus: "synced",
    updateAt: new Date(),
    updateBy: "integration",
    lastPayment: { amount, method, transactionId, at: new Date().toISOString() },
  });

  return { status: 200, body: { ok: true, order_id: orderId, payment_status: "paid", amount, method, transaction_id: transactionId } };
}

export async function getIntegrationShipment(
  ctx: IntegrationRequestContext,
  orderId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getWebFirestore();
  const snap = await db.collection("sale-orders").doc(orderId).get();
  if (!snap.exists) return { status: 404, body: { status: 404, detail: "Order not found" } };
  const d = snap.data() ?? {};
  if (norm(d.companyId) !== ctx.companyId) return { status: 403, body: { status: 403, detail: "Forbidden" } };

  return {
    status: 200,
    body: {
      data: {
        carrier: norm(d.shipmentCarrier),
        tracking_number: norm(d.shipmentTrackingNumber),
        tracking_url: norm(d.shipmentTrackingUrl),
        status: norm(d.shipmentStatus) || "pending",
        estimated_delivery: null,
      },
    },
  };
}

export async function calculateShippingRates(
  _ctx: IntegrationRequestContext,
  body: Record<string, unknown>
): Promise<{ data: Array<Record<string, unknown>> }> {
  const destination = norm(body.destination) || "PE";
  const items = Array.isArray(body.items) ? body.items : [];
  const base = 15 + items.length * 2;
  return {
    data: [
      { carrier: "standard", service: "Envío estándar", rate: base, currency: "PEN", estimated_days: 3 },
      { carrier: "express", service: "Envío express", rate: base * 1.5, currency: "PEN", estimated_days: 1 },
      { carrier: "pickup", service: "Recojo en tienda", rate: 0, currency: "PEN", estimated_days: 0, destination },
    ],
  };
}

export async function createIntegrationInvoice(
  ctx: IntegrationRequestContext,
  orderId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getWebFirestore();
  const orderSnap = await db.collection("sale-orders").doc(orderId).get();
  if (!orderSnap.exists) return { status: 404, body: { status: 404, detail: "Order not found" } };
  const order = orderSnap.data() ?? {};
  if (norm(order.companyId) !== ctx.companyId) return { status: 403, body: { status: 403, detail: "Forbidden" } };

  const existingInvoiceId = norm(order.invoiceId);
  if (existingInvoiceId) {
    const inv = await db.collection("invoices").doc(existingInvoiceId).get();
    if (inv.exists) {
      const id = inv.data() ?? {};
      return {
        status: 200,
        body: {
          invoice_id: existingInvoiceId,
          series: norm(id.documentNo)?.split("-")[0] || "",
          number: norm(id.documentNo),
          status: norm(id.status) || "draft",
          pdf_url: norm(id.pdfUrl),
          cdr_url: norm(id.cdrUrl),
        },
      };
    }
  }

  const clientSnap = await db.collection("clients").doc(norm(order.clientId)).get();
  const client = clientSnap.data() ?? {};
  const now = new Date();
  const invoiceRef = db.collection("invoices").doc();
  const docNo = `WC-${norm(order.externalId) || orderId.slice(0, 8)}`;
  await invoiceRef.set({
    companyId: ctx.companyId,
    accountId: ctx.accountId,
    documentNo: docNo,
    type: norm(body.type) || "01",
    payTerm: "CONTADO",
    settlementId: "",
    settlement: "",
    client: {
      businessName: norm(order.clientName) || norm(client.businessName),
      documentNumber: norm(client.documentNumber),
      documentType: norm(client.documentType),
    },
    company: {},
    companyLocation: {},
    issueDate: now.toISOString().slice(0, 10),
    currency: norm(order.currency) || "PEN",
    status: "draft",
    totalPrice: Number(order.subtotal) || 0,
    totalTax: Number(order.taxAmount) || 0,
    totalAmount: Number(order.total) || 0,
    comment: `Pedido ${norm(order.code)}`,
    zipUrl: "",
    cdrUrl: "",
    pdfUrl: "",
    operationTypeCode: "0101",
    saleOrderId: orderId,
    saleOrderCode: norm(order.code),
    createdAt: now,
    updatedAt: now,
  });

  await db.collection("sale-orders").doc(orderId).update({
    invoiceId: invoiceRef.id,
    status: "invoiced",
    updateAt: now,
  });

  emit({
    companyId: ctx.companyId,
    accountId: ctx.accountId,
    type: "invoice_generated",
    payload: { orderId, externalId: norm(order.externalId), invoiceId: invoiceRef.id, documentNo: docNo },
  }).catch(() => {});
  setImmediate(() => { processOutbox().catch(() => {}); });

  return {
    status: 200,
    body: {
      invoice_id: invoiceRef.id,
      series: "",
      number: docNo,
      status: "draft",
      pdf_url: "",
      cdr_url: "",
    },
  };
}

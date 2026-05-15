import { Router } from "express";
import { getWebFirestore } from "../lib/firebase-admin.js";
import { adjustCount } from "../features/dashboard/tenant-stats.service.js";
import { getCountryByCode, filterAllowedCurrenciesByCountry } from "../data/countries.js";
import { parseCurrencyCode, type CurrencyCode } from "../data/currencies.js";
import {
  resolveUnitOfMeasureFromBody,
  unitDenormalizedFirestoreFields,
  unitFieldsForApiResponse,
} from "../data/units-of-measure.js";
import { FieldValue } from "firebase-admin/firestore";

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function webApiDebug(): boolean {
  const v = String(process.env.WEB_API_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function logWebApi(event: string, data: Record<string, unknown>): void {
  if (!webApiDebug()) return;
  console.log(`[web-api] ${event}`, data);
}

function normalizeText(value: unknown): string | undefined {
  const out = String(value ?? "").trim();
  return out || undefined;
}

/** Firestore rechaza `undefined` en documentos; usar para `set`/`update`. */
function normalizeTextForFirestore(value: unknown): string {
  return normalizeText(value) ?? "";
}

async function getCompanyAllowedCurrencies(db: FirebaseFirestore.Firestore, companyId: string): Promise<{
  allowedCurrencies: CurrencyCode[];
  defaultCurrency: CurrencyCode;
}> {
  const company = await db.collection("companies").doc(companyId).get();
  if (!company.exists) throw new Error("company_not_found");
  const data = (company.data() ?? {}) as Record<string, unknown>;
  const country = getCountryByCode(data.countryCode);
  if (!country) throw new Error("company_currency_config_missing");
  const allowedCurrencies = filterAllowedCurrenciesByCountry(country.code, data.allowedCurrencies) ?? [];
  const defaultCurrency = parseCurrencyCode(data.defaultCurrency);
  if (!allowedCurrencies.length || !defaultCurrency || !allowedCurrencies.includes(defaultCurrency)) {
    throw new Error("company_currency_config_missing");
  }
  return { allowedCurrencies, defaultCurrency };
}

async function normalizeCurrencyOrThrow(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  currencyRaw: unknown
): Promise<CurrencyCode> {
  const { allowedCurrencies, defaultCurrency } = await getCompanyAllowedCurrencies(db, companyId);
  const parsed = parseCurrencyCode(currencyRaw);
  const selected = parsed ?? defaultCurrency;
  if (!allowedCurrencies.includes(selected)) {
    throw new Error("currency_not_allowed");
  }
  return selected;
}

async function requireCompanyScope(req: any): Promise<{ uid: string; accountId: string; companyId: string }> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const companyId = String(req.query?.companyId ?? req.body?.companyId ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  logWebApi("requireCompanyScope:start", {
    companyId,
    uidPrefix: uid.length > 6 ? `${uid.slice(0, 6)}…` : uid,
  });
  const db = getWebFirestore();
  const companyUserSnap = await db
    .collection("company-users")
    .where("companyId", "==", companyId)
    .where("userId", "==", uid)
    .limit(1)
    .get();
  logWebApi("requireCompanyScope:company-users", { empty: companyUserSnap.empty, count: companyUserSnap.size });
  if (companyUserSnap.empty) {
    logWebApi("requireCompanyScope:forbidden", { reason: "no_company_user_doc", companyId });
    throw new Error("forbidden");
  }
  const data = companyUserSnap.docs[0]!.data();
  if (String(data.status ?? "active").trim() === "inactive") {
    logWebApi("requireCompanyScope:forbidden", { reason: "inactive_company_user", companyId });
    throw new Error("forbidden");
  }
  let accountId = String(data.accountId ?? "").trim();
  if (!accountId) {
    const company = await db.collection("companies").doc(companyId).get();
    accountId = String(company.data()?.accountId ?? companyId).trim() || companyId;
    logWebApi("requireCompanyScope:accountId-from-company", { companyId, accountId, companyExists: company.exists });
  }
  logWebApi("requireCompanyScope:ok", { companyId, accountId });
  return { uid, accountId, companyId };
}

function httpStatus(error: string): number {
  if (error === "companyId_required" || error === "validation_error" || error === "invalid_sale_order_item_unit") return 400;
  if (error === "unauthenticated") return 401;
  if (error === "forbidden") return 403;
  if (error === "not_found") return 404;
  if (error === "company_currency_config_missing") return 412;
  if (error === "currency_not_allowed") return 422;
  return 500;
}


// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATIONS CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toQuotationRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    clientId: normalizeText(d.clientId),
    clientName: normalizeText(d.clientName),
    issueDate: normalizeText(d.issueDate),
    validUntil: normalizeText(d.validUntil),
    currency: normalizeText(d.currency),
    subtotal: Number(d.subtotal) || 0,
    taxAmount: Number(d.taxAmount) || 0,
    total: Number(d.total) || 0,
    notes: normalizeText(d.notes),
    status: normalizeText(d.status) || "draft",
    locationId: normalizeText(d.locationId),
    locationName: normalizeText(d.locationName),
    companyId: normalizeText(d.companyId),
    accountId: normalizeText(d.accountId),
    saleOrderId: normalizeText(d.saleOrderId),
    saleOrder: normalizeText(d.saleOrder),
    createAt: d.createAt ?? null,
    createBy: normalizeText(d.createBy),
    updateAt: d.updateAt ?? null,
    updateBy: normalizeText(d.updateBy),
  };
}

/** GET /sales/quotations — List all quotations for the company */
router.get("/quotations", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const locationId = String(req.query?.locationId ?? "").trim();
    let snap;
    if (locationId) {
      snap = await db
        .collection("quotations")
        .where("companyId", "==", companyId)
        .where("locationId", "==", locationId)
        .get();
    } else {
      snap = await db
        .collection("quotations")
        .where("companyId", "==", companyId)
        .where("accountId", "==", accountId)
        .get();
    }
    const items = snap.docs.map(toQuotationRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /sales/quotations/:id — Get a single quotation */
router.get("/quotations/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("quotations").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toQuotationRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /sales/quotations — Create a new quotation */
router.post("/quotations", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: normalizeText(body.code),
      clientId: normalizeText(body.clientId),
      clientName: normalizeText(body.clientName),
      issueDate: normalizeText(body.issueDate),
      validUntil: normalizeTextForFirestore(body.validUntil),
      currency,
      subtotal: Number(body.subtotal) || 0,
      taxAmount: Number(body.taxAmount) || 0,
      total: Number(body.total) || 0,
      notes: normalizeTextForFirestore(body.notes),
      status: normalizeText(body.status) || "draft",
      locationId: normalizeText(body.locationId),
      locationName: normalizeText(body.locationName),
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    const docRef = db.collection("quotations").doc();
    await docRef.set(doc);
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "quotations-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /sales/quotations/:id — Update a quotation */
router.put("/quotations/:id", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("quotations").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const safeFields = [
      "code", "clientId", "clientName", "issueDate", "validUntil",
      "notes", "status", "locationId", "locationName",
    ];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    // Numeric fields
    if (body.subtotal !== undefined) patch.subtotal = Number(body.subtotal) || 0;
    if (body.taxAmount !== undefined) patch.taxAmount = Number(body.taxAmount) || 0;
    if (body.total !== undefined) patch.total = Number(body.total) || 0;

    await db.collection("quotations").doc(id).update(patch);

    // Fire-and-forget: track quotations-confirmed-count on status transitions
    const oldStatus = String(currentData.status ?? "");
    const newStatus = body.status !== undefined ? normalizeText(body.status) : oldStatus;
    if (oldStatus !== "confirmed" && newStatus === "confirmed") {
      adjustCount(db, { accountId, companyId, metricKey: "quotations-confirmed-count", delta: 1 }).catch(() => {});
    } else if (oldStatus === "confirmed" && newStatus !== "confirmed") {
      adjustCount(db, { accountId, companyId, metricKey: "quotations-confirmed-count", delta: -1 }).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /sales/quotations/:id — Delete a quotation */
router.delete("/quotations/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("quotations").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("quotations").doc(id).delete();
    // Fire-and-forget: update tenant stats counters
    adjustCount(db, { accountId, companyId, metricKey: "quotations-count", delta: -1 }).catch(() => {});
    if (String(current.data()?.status ?? "") === "confirmed") {
      adjustCount(db, { accountId, companyId, metricKey: "quotations-confirmed-count", delta: -1 }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// QUOTATION ITEMS CRUD (subcolección)
// ═══════════════════════════════════════════════════════════════════════════════

function toQuotationItemRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    productId: normalizeText(d.productId),
    productName: normalizeText(d.productName),
    productCode: normalizeText(d.productCode),
    quantity: Number(d.quantity) || 0,
    ...unitFieldsForApiResponse(d as Record<string, unknown>),
    unitPrice: Number(d.unitPrice) || 0,
    discount: Number(d.discount) || 0,
    taxAffectation: normalizeText(d.taxAffectation),
    subtotal: Number(d.subtotal) || 0,
    taxAmount: Number(d.taxAmount) || 0,
    total: Number(d.total) || 0,
  };
}

/** GET /sales/quotations/:id/items — List items of a quotation */
router.get("/quotations/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("quotations").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("quotations").doc(id).collection("quotation-items").get();
    const items = snap.docs.map(toQuotationItemRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id/items GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /sales/quotations/:id/items/:itemId — Get a single quotation item */
router.get("/quotations/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("quotations").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("quotations").doc(id).collection("quotation-items").doc(itemId).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    return res.status(200).json(toQuotationItemRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id/items/:itemId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /sales/quotations/:id/items — Add an item to a quotation */
router.post("/quotations/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("quotations").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({
        error: "validation_error",
        message: "unitOfMeasureCode is required and must be a valid catalog code",
      });
    }

    const item: Record<string, unknown> = {
      productId: normalizeTextForFirestore(body.productId),
      productName: normalizeTextForFirestore(body.productName),
      productCode: normalizeTextForFirestore(body.productCode),
      quantity: Number(body.quantity) || 0,
      ...unitDenormalizedFirestoreFields(unitRow),
      unitPrice: Number(body.unitPrice) || 0,
      discount: Number(body.discount) || 0,
      taxAffectation: normalizeTextForFirestore(body.taxAffectation),
      subtotal: Number(body.subtotal) || 0,
      taxAmount: Number(body.taxAmount) || 0,
      total: Number(body.total) || 0,
    };

    const itemRef = db.collection("quotations").doc(id).collection("quotation-items").doc();
    await itemRef.set(item);
    res.status(201).json({ ok: true, id: itemRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id/items POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /sales/quotations/:id/items/:itemId — Update a quotation item */
router.put("/quotations/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("quotations").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("quotations").doc(id).collection("quotation-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(404).json({ error: "not_found" });

    const patch: Record<string, unknown> = {};
    const textFields = ["productId", "productName", "productCode", "taxAffectation"];
    for (const f of textFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.unitOfMeasureCode !== undefined || body.unitOfMeasureId !== undefined || body.unitOfMeasure !== undefined) {
      const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
      if (!unitRow) {
        return res.status(400).json({
          error: "validation_error",
          message: "unitOfMeasureCode is required and must be a valid catalog code",
        });
      }
      Object.assign(patch, unitDenormalizedFirestoreFields(unitRow));
      patch.unitOfMeasure = FieldValue.delete();
    }
    const numericFields = ["quantity", "unitPrice", "discount", "subtotal", "taxAmount", "total"];
    for (const f of numericFields) {
      if (body[f] !== undefined) patch[f] = Number(body[f]) || 0;
    }

    await db.collection("quotations").doc(id).collection("quotation-items").doc(itemId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id/items/:itemId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /sales/quotations/:id/items/:itemId — Delete a quotation item */
router.delete("/quotations/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("quotations").doc(id).get();
    if (!parentSnap.exists) return res.status(200).json({ ok: true });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("quotations").doc(id).collection("quotation-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(200).json({ ok: true });

    await db.collection("quotations").doc(id).collection("quotation-items").doc(itemId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/quotations/:id/items/:itemId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SALE ORDERS CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toSaleOrderRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    clientId: normalizeText(d.clientId),
    clientName: normalizeText(d.clientName),
    quotationId: normalizeText(d.quotationId),
    issueDate: normalizeText(d.issueDate),
    expectedDeliveryDate: normalizeText(d.expectedDeliveryDate),
    currency: normalizeText(d.currency),
    subtotal: Number(d.subtotal) || 0,
    taxAmount: Number(d.taxAmount) || 0,
    total: Number(d.total) || 0,
    notes: normalizeText(d.notes),
    status: normalizeText(d.status) || "draft",
    locationId: normalizeText(d.locationId),
    locationName: normalizeText(d.locationName),
    companyId: normalizeText(d.companyId),
    accountId: normalizeText(d.accountId),
    createAt: d.createAt ?? null,
    createBy: normalizeText(d.createBy),
    updateAt: d.updateAt ?? null,
    updateBy: normalizeText(d.updateBy),
  };
}

/** GET /sales/sale-orders — List all sale orders for the company */
router.get("/sale-orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const locationId = String(req.query?.locationId ?? "").trim();
    let snap;
    if (locationId) {
      snap = await db
        .collection("sale-orders")
        .where("companyId", "==", companyId)
        .where("locationId", "==", locationId)
        .get();
    } else {
      snap = await db
        .collection("sale-orders")
        .where("companyId", "==", companyId)
        .where("accountId", "==", accountId)
        .get();
    }
    const items = snap.docs.map(toSaleOrderRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /sales/sale-orders/:id — Get a single sale order */
router.get("/sale-orders/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("sale-orders").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toSaleOrderRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /sales/sale-orders — Create a new sale order */
router.post("/sale-orders", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: normalizeText(body.code),
      clientId: normalizeText(body.clientId),
      clientName: normalizeText(body.clientName),
      quotationId: normalizeTextForFirestore(body.quotationId),
      issueDate: normalizeText(body.issueDate),
      expectedDeliveryDate: normalizeTextForFirestore(body.expectedDeliveryDate),
      currency,
      subtotal: Number(body.subtotal) || 0,
      taxAmount: Number(body.taxAmount) || 0,
      total: Number(body.total) || 0,
      notes: normalizeTextForFirestore(body.notes),
      status: normalizeText(body.status) || "draft",
      locationId: normalizeText(body.locationId),
      locationName: normalizeText(body.locationName),
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    const docRef = db.collection("sale-orders").doc();
    await docRef.set(doc);

    // Link back to quotation if this sale order was generated from one
    const quotationId = normalizeText(body.quotationId);
    if (quotationId) {
      const quotationRef = db.collection("quotations").doc(quotationId);
      const quotationSnap = await quotationRef.get();
      if (quotationSnap.exists) {
        await quotationRef.update({
          saleOrderId: docRef.id,
          saleOrder: normalizeText(body.code),
          updateAt: now,
          updateBy: uid,
        });
      }
    }

    // Fire-and-forget: update tenant stats counters
    adjustCount(db, { accountId, companyId, metricKey: "sale-orders-count", delta: 1 }).catch(() => {});
    const totalAmount = Number(body.total) || 0;
    if (totalAmount > 0) {
      adjustCount(db, { accountId, companyId, metricKey: "sale-orders-total", delta: totalAmount }).catch(() => {});
    }
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /sales/sale-orders/:id — Update a sale order */
router.put("/sale-orders/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("sale-orders").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const safeFields = [
      "code", "clientId", "clientName", "quotationId", "issueDate", "expectedDeliveryDate",
      "notes", "status", "locationId", "locationName",
    ];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    // Numeric fields
    if (body.subtotal !== undefined) patch.subtotal = Number(body.subtotal) || 0;
    if (body.taxAmount !== undefined) patch.taxAmount = Number(body.taxAmount) || 0;
    if (body.total !== undefined) patch.total = Number(body.total) || 0;

    await db.collection("sale-orders").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /sales/sale-orders/:id — Delete a sale order */
router.delete("/sale-orders/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("sale-orders").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("sale-orders").doc(id).delete();
    // Fire-and-forget: update tenant stats counters
    adjustCount(db, { accountId, companyId, metricKey: "sale-orders-count", delta: -1 }).catch(() => {});
    const deletedTotal = Number(current.data()?.total) || 0;
    if (deletedTotal > 0) {
      adjustCount(db, { accountId, companyId, metricKey: "sale-orders-total", delta: -deletedTotal }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SALE ORDER ITEMS CRUD (subcolección)
// ═══════════════════════════════════════════════════════════════════════════════

function toSaleOrderItemRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    productId: normalizeText(d.productId),
    productName: normalizeText(d.productName),
    productCode: normalizeText(d.productCode),
    quantity: Number(d.quantity) || 0,
    ...unitFieldsForApiResponse(d as Record<string, unknown>),
    unitPrice: Number(d.unitPrice) || 0,
    discount: Number(d.discount) || 0,
    taxAffectation: normalizeText(d.taxAffectation),
    subtotal: Number(d.subtotal) || 0,
    taxAmount: Number(d.taxAmount) || 0,
    total: Number(d.total) || 0,
    dispatchedQuantity: Number(d.dispatchedQuantity) || 0,
  };
}

/** GET /sales/sale-orders/:id/items — List items of a sale order */
router.get("/sale-orders/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("sale-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("sale-orders").doc(id).collection("sale-order-items").get();
    const items = snap.docs.map(toSaleOrderItemRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/items GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /sales/sale-orders/:id/items/:itemId — Get a single sale order item */
router.get("/sale-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("sale-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("sale-orders").doc(id).collection("sale-order-items").doc(itemId).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    return res.status(200).json(toSaleOrderItemRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/items/:itemId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /sales/sale-orders/:id/items — Add an item to a sale order */
router.post("/sale-orders/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("sale-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({
        error: "validation_error",
        message: "unitOfMeasureCode is required and must be a valid catalog code",
      });
    }

    const item: Record<string, unknown> = {
      productId: normalizeTextForFirestore(body.productId),
      productName: normalizeTextForFirestore(body.productName),
      productCode: normalizeTextForFirestore(body.productCode),
      quantity: Number(body.quantity) || 0,
      ...unitDenormalizedFirestoreFields(unitRow),
      unitPrice: Number(body.unitPrice) || 0,
      discount: Number(body.discount) || 0,
      taxAffectation: normalizeTextForFirestore(body.taxAffectation),
      subtotal: Number(body.subtotal) || 0,
      taxAmount: Number(body.taxAmount) || 0,
      total: Number(body.total) || 0,
      dispatchedQuantity: 0,
    };

    const itemRef = db.collection("sale-orders").doc(id).collection("sale-order-items").doc();
    await itemRef.set(item);
    res.status(201).json({ ok: true, id: itemRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/items POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /sales/sale-orders/:id/items/:itemId — Update a sale order item */
router.put("/sale-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("sale-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("sale-orders").doc(id).collection("sale-order-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(404).json({ error: "not_found" });

    const patch: Record<string, unknown> = {};
    const textFields = ["productId", "productName", "productCode", "taxAffectation"];
    for (const f of textFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.unitOfMeasureCode !== undefined || body.unitOfMeasureId !== undefined || body.unitOfMeasure !== undefined) {
      const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
      if (!unitRow) {
        return res.status(400).json({
          error: "validation_error",
          message: "unitOfMeasureCode is required and must be a valid catalog code",
        });
      }
      Object.assign(patch, unitDenormalizedFirestoreFields(unitRow));
      patch.unitOfMeasure = FieldValue.delete();
    }
    const numericFields = ["quantity", "unitPrice", "discount", "subtotal", "taxAmount", "total", "dispatchedQuantity"];
    for (const f of numericFields) {
      if (body[f] !== undefined) patch[f] = Number(body[f]) || 0;
    }

    await db.collection("sale-orders").doc(id).collection("sale-order-items").doc(itemId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/items/:itemId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /sales/sale-orders/:id/items/:itemId — Delete a sale order item */
router.delete("/sale-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("sale-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(200).json({ ok: true });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("sale-orders").doc(id).collection("sale-order-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(200).json({ ok: true });

    await db.collection("sale-orders").doc(id).collection("sale-order-items").doc(itemId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/items/:itemId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});



// ═══════════════════════════════════════════════════════════════════════════════
// SALE ORDER DISPATCH (atomic operation)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /sales/sale-orders/:id/dispatch — Dispatch items from a sale order.
 * Creates exit inventory movements and decrements stock atomically.
 * Rejects the entire operation if any item has insufficient stock (HTTP 409).
 */
router.post("/sale-orders/:id/dispatch", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    // --- 1. Validate the order exists and belongs to the company ---
    const orderSnap = await db.collection("sale-orders").doc(id).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: "not_found", message: "Sale order not found" });
    }
    const orderData = orderSnap.data() ?? {};
    if (String(orderData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    // --- 2. Validate status is "confirmed" or "in_progress" ---
    const orderStatus = String(orderData.status ?? "").trim();
    if (orderStatus !== "confirmed" && orderStatus !== "in_progress") {
      return res.status(409).json({
        error: "invalid_status",
        message: `Cannot dispatch order in status "${orderStatus}". Must be "confirmed" or "in_progress".`,
      });
    }

    // --- 3. Validate request body ---
    const warehouseId = String(body.warehouseId ?? "").trim();
    const warehouseName = String(body.warehouseName ?? "").trim();
    const items: Array<{ itemId: string; dispatchedQuantity: number }> = Array.isArray(body.items) ? body.items : [];

    if (!warehouseId) {
      return res.status(400).json({ error: "validation_error", message: "warehouseId is required" });
    }

    // Filter items with dispatchedQuantity > 0 (Req 15.5: exclude items with 0 quantity)
    const validItems = items
      .map((item) => ({
        itemId: String(item.itemId ?? "").trim(),
        dispatchedQuantity: Number(item.dispatchedQuantity) || 0,
      }))
      .filter((item) => item.itemId && item.dispatchedQuantity > 0);

    if (validItems.length === 0) {
      return res.status(400).json({ error: "validation_error", message: "At least one item with dispatchedQuantity > 0 is required" });
    }

    // --- 4. Firestore transaction: validate stock, create movements, update items ---
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]!; // YYYY-MM-DD

    await db.runTransaction(async (transaction) => {
      // a. Read all sale-order-items and stock-levels within the transaction
      const itemReads: Array<{
        itemId: string;
        dispatchedQuantity: number;
        itemRef: FirebaseFirestore.DocumentReference;
        stockRef: FirebaseFirestore.DocumentReference;
      }> = [];

      for (const vi of validItems) {
        const itemRef = db.collection("sale-orders").doc(id).collection("sale-order-items").doc(vi.itemId);
        const productId = ""; // Will be read from the item doc
        itemReads.push({
          itemId: vi.itemId,
          dispatchedQuantity: vi.dispatchedQuantity,
          itemRef,
          stockRef: null as any, // Will be set after reading item
        });
      }

      // Read all item documents
      const itemSnaps = await Promise.all(
        itemReads.map((ir) => transaction.get(ir.itemRef))
      );

      // Build stock refs based on productId from items
      const stockRefsMap: Map<string, FirebaseFirestore.DocumentReference> = new Map();
      const itemDataList: Array<{
        itemId: string;
        dispatchedQuantity: number;
        itemRef: FirebaseFirestore.DocumentReference;
        stockRef: FirebaseFirestore.DocumentReference;
        productId: string;
        productName: string;
        unitFirestore: Record<string, string>;
        quantity: number;
        currentDispatched: number;
      }> = [];

      for (let i = 0; i < itemReads.length; i++) {
        const snap = itemSnaps[i]!;
        if (!snap.exists) {
          throw new Error("not_found");
        }
        const itemData = snap.data() ?? {};
        const productId = String(itemData.productId ?? "").trim();
        const stockLevelId = `${productId}_${warehouseId}`;
        const stockRef = db.collection("stock-levels").doc(stockLevelId);

        if (!stockRefsMap.has(stockLevelId)) {
          stockRefsMap.set(stockLevelId, stockRef);
        }

        const unitRow = resolveUnitOfMeasureFromBody(itemData as Record<string, unknown>);
        if (!unitRow) {
          throw new Error("invalid_sale_order_item_unit");
        }
        const unitFirestore = unitDenormalizedFirestoreFields(unitRow);

        itemDataList.push({
          itemId: itemReads[i]!.itemId,
          dispatchedQuantity: itemReads[i]!.dispatchedQuantity,
          itemRef: itemReads[i]!.itemRef,
          stockRef,
          productId,
          productName: String(itemData.productName ?? "").trim(),
          unitFirestore,
          quantity: Number(itemData.quantity) || 0,
          currentDispatched: Number(itemData.dispatchedQuantity) || 0,
        });
      }

      // Read all unique stock-level documents
      const stockRefs = Array.from(stockRefsMap.values());
      const stockSnaps = await Promise.all(
        stockRefs.map((ref) => transaction.get(ref))
      );
      const stockMap: Map<string, { snap: FirebaseFirestore.DocumentSnapshot; quantity: number }> = new Map();
      for (let i = 0; i < stockRefs.length; i++) {
        const snap = stockSnaps[i]!;
        const currentStock = snap.exists ? (Number(snap.data()?.quantity) || 0) : 0;
        stockMap.set(stockRefs[i]!.id, { snap, quantity: currentStock });
      }

      // Read all sale-order items once (before any writes — Firestore transaction rule).
      const allItemsColl = db.collection("sale-orders").doc(id).collection("sale-order-items");
      const allItemsSnap = await transaction.get(allItemsColl);

      // b. Validate stock for each item (accounting for multiple items sharing same product)
      for (const item of itemDataList) {
        const stockLevelId = `${item.productId}_${warehouseId}`;
        const stockEntry = stockMap.get(stockLevelId)!;
        if (stockEntry.quantity < item.dispatchedQuantity) {
          // Throw with product info for the error response
          const err = new Error("insufficient_stock") as any;
          err.productName = item.productName;
          err.productId = item.productId;
          throw err;
        }
        // Decrement in the map so subsequent items sharing the same product are validated correctly
        stockEntry.quantity -= item.dispatchedQuantity;
      }

      // Reset stock quantities for the actual write phase
      for (let i = 0; i < stockRefs.length; i++) {
        const snap = stockSnaps[i]!;
        const currentStock = snap.exists ? (Number(snap.data()?.quantity) || 0) : 0;
        stockMap.set(stockRefs[i]!.id, { snap, quantity: currentStock });
      }

      // c. Create inventory movements and decrement stock for each item
      const dispatchedRunningByItemId = new Map<string, number>();

      for (const item of itemDataList) {
        const stockLevelId = `${item.productId}_${warehouseId}`;
        const stockEntry = stockMap.get(stockLevelId)!;

        // Create exit movement
        const movementRef = db.collection("inventory-movements").doc();
        transaction.set(movementRef, {
          type: "exit",
          productId: item.productId,
          productName: item.productName,
          warehouseId,
          warehouseName,
          quantity: item.dispatchedQuantity,
          ...item.unitFirestore,
          referenceType: "sale-order",
          referenceId: id,
          date: dateStr,
          locationId: normalizeText(orderData.locationId) || "",
          locationName: normalizeText(orderData.locationName) || "",
          companyId,
          accountId,
          createAt: now,
          createBy: uid,
        });

        // Decrement stock
        const newQuantity = stockEntry.quantity - item.dispatchedQuantity;
        if (stockEntry.snap.exists) {
          transaction.update(stockEntry.snap.ref, {
            quantity: newQuantity,
            lastMovementDate: dateStr,
          });
        } else {
          transaction.set(stockEntry.snap.ref, {
            productId: item.productId,
            productName: item.productName,
            warehouseId,
            warehouseName,
            quantity: newQuantity,
            ...item.unitFirestore,
            lastMovementDate: dateStr,
            locationId: normalizeText(orderData.locationId) || "",
            companyId,
            accountId,
          });
        }

        // Update the consumed stock in our map (for items sharing the same product+warehouse)
        stockEntry.quantity = newQuantity;

        // Update item's dispatchedQuantity (varias líneas con el mismo itemId en un solo dispatch)
        const prevDispatched = dispatchedRunningByItemId.has(item.itemId)
          ? dispatchedRunningByItemId.get(item.itemId)!
          : item.currentDispatched;
        const newDispatched = prevDispatched + item.dispatchedQuantity;
        dispatchedRunningByItemId.set(item.itemId, newDispatched);
        transaction.update(item.itemRef, { dispatchedQuantity: newDispatched });
      }

      // d. Determine new order status — all items read already in allItemsSnap
      const updatedDispatchMap: Map<string, number> = new Map(dispatchedRunningByItemId);

      let allFullyDispatched = true;
      for (const doc of allItemsSnap.docs) {
        const docData = doc.data() ?? {};
        const orderedQty = Number(docData.quantity) || 0;
        const dispatchedQty = updatedDispatchMap.has(doc.id)
          ? updatedDispatchMap.get(doc.id)!
          : (Number(docData.dispatchedQuantity) || 0);

        if (dispatchedQty < orderedQty) {
          allFullyDispatched = false;
          break;
        }
      }

      // Update order status
      const newStatus = allFullyDispatched ? "delivered" : "in_progress";
      transaction.update(db.collection("sale-orders").doc(id), {
        status: newStatus,
        updateAt: now,
        updateBy: uid,
      });
    });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/sales/sale-orders/:id/dispatch POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);

    if (msg === "insufficient_stock") {
      return res.status(409).json({
        error: "insufficient_stock",
        product: String(e.productName ?? "").trim(),
        productId: String(e.productId ?? "").trim(),
        warehouse: String(req.body?.warehouseName ?? "").trim(),
      });
    }

    if (msg === "invalid_status") {
      return res.status(409).json({ error: "invalid_status", message: e.message });
    }

    if (msg === "not_found") {
      return res.status(404).json({ error: "not_found" });
    }

    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

export default router;

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
  if (error === "companyId_required" || error === "validation_error") return 400;
  if (error === "unauthenticated") return 401;
  if (error === "forbidden") return 403;
  if (error === "not_found") return 404;
  if (error === "company_currency_config_missing") return 412;
  if (error === "currency_not_allowed") return 422;
  return 500;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLIERS CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toSupplierRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    businessName: normalizeText(d.businessName),
    commercialName: normalizeText(d.commercialName),
    documentTypeId: normalizeText(d.documentTypeId),
    documentNumber: normalizeText(d.documentNumber),
    contact: d.contact && typeof d.contact === "object" ? {
      contactName: normalizeText((d.contact as any).contactName),
      email: normalizeText((d.contact as any).email),
      phone: normalizeText((d.contact as any).phone),
    } : { contactName: undefined, email: undefined, phone: undefined },
    paymentCondition: normalizeText(d.paymentCondition),
    currency: normalizeText(d.currency),
    status: String(d.status ?? "active").trim() === "inactive" ? "inactive" : "active",
    companyId: normalizeText(d.companyId),
    accountId: normalizeText(d.accountId),
    createAt: d.createAt ?? null,
    createBy: normalizeText(d.createBy),
    updateAt: d.updateAt ?? null,
    updateBy: normalizeText(d.updateBy),
  };
}

/** GET /purchasing/suppliers — List all suppliers for the company */
router.get("/suppliers", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("suppliers")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toSupplierRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/suppliers GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /purchasing/suppliers/:id — Get a single supplier */
router.get("/suppliers/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("suppliers").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toSupplierRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/suppliers/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /purchasing/suppliers — Create a new supplier */
router.post("/suppliers", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    const businessName = normalizeText(body.businessName);
    if (!businessName) return res.status(400).json({ error: "validation_error", message: "businessName is required" });

    const contact = body.contact && typeof body.contact === "object" ? (body.contact as any) : {};
    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: normalizeTextForFirestore(body.code),
      businessName,
      commercialName: normalizeTextForFirestore(body.commercialName),
      documentTypeId: normalizeTextForFirestore(body.documentTypeId),
      documentNumber: normalizeTextForFirestore(body.documentNumber),
      contact: {
        contactName: normalizeTextForFirestore(contact.contactName),
        email: normalizeTextForFirestore(contact.email),
        phone: normalizeTextForFirestore(contact.phone),
      },
      paymentCondition: normalizeTextForFirestore(body.paymentCondition),
      currency,
      status: String(body.status ?? "active").trim() === "inactive" ? "inactive" : "active",
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    const docRef = db.collection("suppliers").doc();
    await docRef.set(doc);
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "suppliers-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/suppliers POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /purchasing/suppliers/:id — Update a supplier */
router.put("/suppliers/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("suppliers").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const safeFields = ["code", "businessName", "commercialName", "documentTypeId", "documentNumber", "paymentCondition", "status"];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    if (body.contact !== undefined && body.contact !== null) {
      const c = body.contact as any;
      patch.contact = {
        contactName: normalizeTextForFirestore(c?.contactName),
        email: normalizeTextForFirestore(c?.email),
        phone: normalizeTextForFirestore(c?.phone),
      };
    }

    await db.collection("suppliers").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/suppliers/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /purchasing/suppliers/:id — Delete a supplier */
router.delete("/suppliers/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("suppliers").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("suppliers").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "suppliers-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/suppliers/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE ORDERS CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toPurchaseOrderRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    supplierId: normalizeText(d.supplierId),
    supplierName: normalizeText(d.supplierName),
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

/** GET /purchasing/purchase-orders — List all purchase orders for the company */
router.get("/purchase-orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("purchase-orders")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toPurchaseOrderRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /purchasing/purchase-orders/:id — Get a single purchase order */
router.get("/purchase-orders/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("purchase-orders").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toPurchaseOrderRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /purchasing/purchase-orders — Create a new purchase order */
router.post("/purchase-orders", async (req, res) => {
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
      supplierId: normalizeText(body.supplierId),
      supplierName: normalizeText(body.supplierName),
      issueDate: normalizeText(body.issueDate),
      expectedDeliveryDate: normalizeText(body.expectedDeliveryDate),
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

    const docRef = db.collection("purchase-orders").doc();
    await docRef.set(doc);
    // Fire-and-forget: update tenant stats counters
    adjustCount(db, { accountId, companyId, metricKey: "purchase-orders-count", delta: 1 }).catch(() => {});
    const totalAmount = Number(body.total) || 0;
    if (totalAmount > 0) {
      adjustCount(db, { accountId, companyId, metricKey: "purchase-orders-total", delta: totalAmount }).catch(() => {});
    }
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /purchasing/purchase-orders/:id — Update a purchase order */
router.put("/purchase-orders/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("purchase-orders").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const safeFields = [
      "code", "supplierId", "supplierName", "issueDate", "expectedDeliveryDate",
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

    await db.collection("purchase-orders").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /purchasing/purchase-orders/:id — Delete a purchase order */
router.delete("/purchase-orders/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("purchase-orders").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("purchase-orders").doc(id).delete();
    // Fire-and-forget: update tenant stats counters
    adjustCount(db, { accountId, companyId, metricKey: "purchase-orders-count", delta: -1 }).catch(() => {});
    const deletedTotal = Number(current.data()?.total) || 0;
    if (deletedTotal > 0) {
      adjustCount(db, { accountId, companyId, metricKey: "purchase-orders-total", delta: -deletedTotal }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE ORDER ITEMS CRUD (subcolección)
// ═══════════════════════════════════════════════════════════════════════════════

function toPurchaseOrderItemRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    productId: normalizeText(d.productId),
    productName: normalizeText(d.productName),
    quantity: Number(d.quantity) || 0,
    ...unitFieldsForApiResponse(d as Record<string, unknown>),
    unitPrice: Number(d.unitPrice) || 0,
    taxAffectation: normalizeText(d.taxAffectation),
    subtotal: Number(d.subtotal) || 0,
    taxAmount: Number(d.taxAmount) || 0,
    total: Number(d.total) || 0,
    receivedQuantity: Number(d.receivedQuantity) || 0,
  };
}

/** GET /purchasing/purchase-orders/:id/items — List items of a purchase order */
router.get("/purchase-orders/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("purchase-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("purchase-orders").doc(id).collection("purchase-order-items").get();
    const items = snap.docs.map(toPurchaseOrderItemRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/items GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** GET /purchasing/purchase-orders/:id/items/:itemId — Get a single item */
router.get("/purchase-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("purchase-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const snap = await db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc(itemId).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    return res.status(200).json(toPurchaseOrderItemRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/items/:itemId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** POST /purchasing/purchase-orders/:id/items — Add an item to a purchase order */
router.post("/purchase-orders/:id/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("purchase-orders").doc(id).get();
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
      quantity: Number(body.quantity) || 0,
      ...unitDenormalizedFirestoreFields(unitRow),
      unitPrice: Number(body.unitPrice) || 0,
      taxAffectation: normalizeTextForFirestore(body.taxAffectation),
      subtotal: Number(body.subtotal) || 0,
      taxAmount: Number(body.taxAmount) || 0,
      total: Number(body.total) || 0,
      receivedQuantity: 0,
    };

    const itemRef = db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc();
    await itemRef.set(item);
    res.status(201).json({ ok: true, id: itemRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/items POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** PUT /purchasing/purchase-orders/:id/items/:itemId — Update an item */
router.put("/purchase-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;
    const body = req.body ?? {};

    // Verify parent document belongs to company
    const parentSnap = await db.collection("purchase-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(404).json({ error: "not_found" });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(404).json({ error: "not_found" });

    const patch: Record<string, unknown> = {};
    const textFields = ["productId", "productName", "taxAffectation"];
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
    const numericFields = ["quantity", "unitPrice", "subtotal", "taxAmount", "total", "receivedQuantity"];
    for (const f of numericFields) {
      if (body[f] !== undefined) patch[f] = Number(body[f]) || 0;
    }

    await db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc(itemId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/items/:itemId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

/** DELETE /purchasing/purchase-orders/:id/items/:itemId — Delete an item */
router.delete("/purchase-orders/:id/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id, itemId } = req.params;

    // Verify parent document belongs to company
    const parentSnap = await db.collection("purchase-orders").doc(id).get();
    if (!parentSnap.exists) return res.status(200).json({ ok: true });
    if (String(parentSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const itemSnap = await db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc(itemId).get();
    if (!itemSnap.exists) return res.status(200).json({ ok: true });

    await db.collection("purchase-orders").doc(id).collection("purchase-order-items").doc(itemId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/items/:itemId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE ORDER RECEIVE (Atomic reception)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /purchasing/purchase-orders/:id/receive
 * Receives items from a purchase order, creating inventory movements and updating stock.
 *
 * Body:
 * {
 *   companyId: string,
 *   warehouseId: string,
 *   warehouseName: string,
 *   items: [{ itemId: string, receivedQuantity: number }, ...]
 * }
 */
router.post("/purchase-orders/:id/receive", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    // --- Validate request body ---
    const warehouseId = String(body.warehouseId ?? "").trim();
    const warehouseName = String(body.warehouseName ?? "").trim();
    const items: Array<{ itemId: string; receivedQuantity: number }> = Array.isArray(body.items) ? body.items : [];

    if (!warehouseId) {
      return res.status(400).json({ error: "validation_error", message: "warehouseId is required" });
    }
    if (!items.length) {
      return res.status(400).json({ error: "validation_error", message: "items array is required and must not be empty" });
    }

    // --- Verify purchase order exists and belongs to company ---
    const orderSnap = await db.collection("purchase-orders").doc(id).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: "not_found", message: "Purchase order not found" });
    }
    const orderData = orderSnap.data()!;
    if (String(orderData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    // --- Validate status ---
    const currentStatus = String(orderData.status ?? "").trim();
    if (currentStatus !== "confirmed" && currentStatus !== "partial_received") {
      return res.status(409).json({
        error: "invalid_status",
        message: `Cannot receive items for an order in status "${currentStatus}". Order must be "confirmed" or "partial_received".`,
      });
    }

    // --- Extract location info from the order ---
    const locationId = String(orderData.locationId ?? "").trim();
    const locationName = String(orderData.locationName ?? "").trim();

    // --- Run Firestore transaction ---
    // Firestore: all reads before any writes. The previous loop interleaved
    // movement writes with stock reads, which triggers "all reads before all writes".
    await db.runTransaction(async (transaction) => {
      const itemsCollRef = db.collection("purchase-orders").doc(id).collection("purchase-order-items");
      const allItemsSnap = await transaction.get(itemsCollRef);
      const allItemsMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      allItemsSnap.docs.forEach((doc) => allItemsMap.set(doc.id, doc));

      // b. Validate each received item + build work list (no writes yet)
      type ReceiveWork = {
        itemId: string;
        receivedQty: number;
        productId: string;
        productName: string;
        unitFirestore: Record<string, string>;
        alreadyReceived: number;
      };
      const workList: ReceiveWork[] = [];
      /** Suma por ítem en esta misma petición (evita superar pendiente con líneas duplicadas). */
      const batchQtyByItemId = new Map<string, number>();

      for (const receivedItem of items) {
        const itemId = String(receivedItem.itemId ?? "").trim();
        const receivedQty = Number(receivedItem.receivedQuantity);

        if (!itemId) {
          throw new Error("validation_error:itemId is required for each item");
        }

        const itemDoc = allItemsMap.get(itemId);
        if (!itemDoc) {
          throw new Error(`validation_error:Item "${itemId}" not found in this purchase order`);
        }

        const itemData = itemDoc.data();
        const orderedQuantity = Number(itemData.quantity) || 0;
        const alreadyReceived = Number(itemData.receivedQuantity) || 0;
        const pendingQuantity = orderedQuantity - alreadyReceived;

        if (receivedQty < 1) {
          throw new Error(`validation_error:receivedQuantity for item "${itemId}" must be >= 1`);
        }
        const batchSoFar = batchQtyByItemId.get(itemId) || 0;
        if (batchSoFar + receivedQty > pendingQuantity) {
          throw new Error(
            `validation_error:receivedQuantity for item "${itemId}" must be <= ${pendingQuantity} (pending). Ordered: ${orderedQuantity}, already received: ${alreadyReceived}, already in this request: ${batchSoFar}`
          );
        }
        batchQtyByItemId.set(itemId, batchSoFar + receivedQty);

        const productId = String(itemData.productId ?? "").trim();
        const productName = String(itemData.productName ?? "").trim();
        const unitRow = resolveUnitOfMeasureFromBody(itemData as Record<string, unknown>);
        if (!unitRow) {
          throw new Error("validation_error:Invalid or missing unit of measure on purchase order item");
        }
        const unitFirestore = unitDenormalizedFirestoreFields(unitRow);

        workList.push({
          itemId,
          receivedQty,
          productId,
          productName,
          unitFirestore,
          alreadyReceived,
        });
      }

      // c. Read every stock-level doc touched by this reception (reads only)
      const stockLevelIds = new Set<string>();
      for (const w of workList) {
        stockLevelIds.add(`${w.productId}_${warehouseId}`);
      }
      const stockRefs = [...stockLevelIds].map((sid) => db.collection("stock-levels").doc(sid));
      const stockSnaps = await Promise.all(stockRefs.map((ref) => transaction.get(ref)));
      const stockById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      stockRefs.forEach((ref, i) => stockById.set(ref.id, stockSnaps[i]!));

      const deltaByStockId = new Map<string, number>();
      for (const w of workList) {
        const sid = `${w.productId}_${warehouseId}`;
        deltaByStockId.set(sid, (deltaByStockId.get(sid) || 0) + w.receivedQty);
      }

      const now = new Date().toISOString().split("T")[0]!; // Use today's date for movements

      // Running total por línea de OC (misma petición puede traer el mismo itemId varias veces).
      const receivedRunningByItemId = new Map<string, number>();

      // d. Writes only: movements + item lines + stock + order header
      for (const w of workList) {
        const movementRef = db.collection("inventory-movements").doc();
        transaction.set(movementRef, {
          type: "entry",
          productId: w.productId,
          productName: w.productName,
          warehouseId,
          warehouseName,
          quantity: w.receivedQty,
          ...w.unitFirestore,
          referenceType: "purchase-order",
          referenceId: id,
          date: now,
          locationId,
          locationName,
          companyId,
          accountId,
          createAt: new Date(),
          createBy: uid,
        });

        const prevReceived = receivedRunningByItemId.has(w.itemId)
          ? receivedRunningByItemId.get(w.itemId)!
          : w.alreadyReceived;
        const newReceivedTotal = prevReceived + w.receivedQty;
        receivedRunningByItemId.set(w.itemId, newReceivedTotal);

        const itemRef = itemsCollRef.doc(w.itemId);
        transaction.update(itemRef, {
          receivedQuantity: newReceivedTotal,
        });
      }

      for (const sid of stockLevelIds) {
        const stockSnap = stockById.get(sid)!;
        const delta = deltaByStockId.get(sid) || 0;
        const currentStock = stockSnap.exists ? (Number(stockSnap.data()?.quantity) || 0) : 0;
        const newStock = currentStock + delta;
        const stockLevelRef = db.collection("stock-levels").doc(sid);
        const w = workList.find((x) => `${x.productId}_${warehouseId}` === sid)!;

        if (stockSnap.exists) {
          transaction.update(stockLevelRef, {
            quantity: newStock,
            lastMovementDate: now,
          });
        } else {
          transaction.set(stockLevelRef, {
            productId: w.productId,
            productName: w.productName,
            warehouseId,
            warehouseName,
            quantity: newStock,
            ...w.unitFirestore,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }
      }

      // e. New order status from in-memory bumps (supports duplicate itemId lines in one request)
      const receivedBumpByItemId = new Map<string, number>();
      for (const w of workList) {
        receivedBumpByItemId.set(w.itemId, (receivedBumpByItemId.get(w.itemId) || 0) + w.receivedQty);
      }

      let allFullyReceived = true;
      for (const [docId, doc] of allItemsMap) {
        const data = doc.data();
        const orderedQuantity = Number(data.quantity) || 0;
        const alreadyReceived = Number(data.receivedQuantity) || 0;
        const bump = receivedBumpByItemId.get(docId) || 0;
        const totalReceived = alreadyReceived + bump;

        if (totalReceived < orderedQuantity) {
          allFullyReceived = false;
          break;
        }
      }

      const newStatus = allFullyReceived ? "received" : "partial_received";
      const orderRef = db.collection("purchase-orders").doc(id);
      transaction.update(orderRef, {
        status: newStatus,
        updateAt: new Date(),
        updateBy: uid,
      });
    });

    // Fire-and-forget: update inventory movements count
    const movementCount = items.length;
    adjustCount(db, { accountId, companyId, metricKey: "inventory-movements-count", delta: movementCount }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/purchasing/purchase-orders/:id/receive POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);

    // Handle validation errors with custom messages
    if (msg.startsWith("validation_error:")) {
      return res.status(400).json({ error: "validation_error", message: msg.replace("validation_error:", "") });
    }

    return res.status(httpStatus(msg)).json({ error: msg });
  }
});

export default router;

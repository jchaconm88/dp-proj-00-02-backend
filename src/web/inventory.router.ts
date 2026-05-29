import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { getWebFirestore } from "../lib/firebase-admin.js";
import { trackEntityChange } from "../features/dashboard/snapshot-incremental.service.js";
import { updateEntitySearchIndex } from "../features/search/entity-search-index.service.js";
import { getCountryByCode, filterAllowedCurrenciesByCountry } from "../data/countries.js";
import { parseCurrencyCode, type CurrencyCode } from "../data/currencies.js";
import {
  resolveUnitOfMeasureFromBody,
  unitDenormalizedFirestoreFields,
  unitFieldsForApiResponse,
} from "../data/units-of-measure.js";
import {
  VARIANT_ATTRIBUTE_TYPE_CODE_RE,
  buildAttributeDefinitions,
  buildVariantAttributeLabels,
  loadVariantAttributeTypesByCode,
  parseVariantAttributeLabels,
  normalizeAttributesInput,
  normalizeVariantTypeCode,
  normalizeVariantTypeValues,
  parseVariantAttributeTypeCodes,
  validateVariantAttributeTypeCodes,
  validateVariantAttributes,
} from "./variant-attribute-types.helpers.js";

const router = Router();
const PRODUCT_TYPES = new Set([
  "good",
  "service",
  "raw_material",
  "finished_good",
  "semi_finished",
  "by_product",
  "supply",
]);

function normalizeProductType(value: unknown): string {
  const raw = String(value ?? "").trim();
  return PRODUCT_TYPES.has(raw) ? raw : "good";
}

function normalizeText(value: unknown): string | undefined {
  const out = String(value ?? "").trim();
  return out || undefined;
}

/** Firestore no acepta `undefined`; usar en POST/PUT para campos opcionales. */
function normalizeTextForFirestore(value: unknown): string {
  return normalizeText(value) ?? "";
}

function validateVariantSkuAgainstParent(parentSku: string, variantSku: string): string | null {
  const variant = variantSku.trim();
  if (!variant) {
    return "El SKU de la variación es obligatorio.";
  }
  const parent = parentSku.trim();
  if (parent && parent.toLowerCase() === variant.toLowerCase()) {
    return "El SKU de la variación debe ser distinto al SKU del producto padre.";
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function requireCompanyScope(req: any): Promise<{ uid: string; accountId: string; companyId: string }> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const companyId = String(req.query?.companyId ?? req.body?.companyId ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  const db = getWebFirestore();
  const companyUserSnap = await db
    .collection("company-users")
    .where("companyId", "==", companyId)
    .where("userId", "==", uid)
    .limit(1)
    .get();
  if (companyUserSnap.empty) throw new Error("forbidden");
  const data = companyUserSnap.docs[0]!.data();
  if (String(data.status ?? "active").trim() === "inactive") throw new Error("forbidden");
  let accountId = String(data.accountId ?? "").trim();
  if (!accountId) {
    const company = await db.collection("companies").doc(companyId).get();
    accountId = String(company.data()?.accountId ?? companyId).trim() || companyId;
  }
  return { uid, accountId, companyId };
}

function httpStatusForError(msg: string): number {
  if (msg === "unauthenticated") return 401;
  if (msg === "forbidden") return 403;
  if (msg === "companyId_required" || msg === "validation_error") return 400;
  if (msg === "company_currency_config_missing") return 412;
  if (msg === "currency_not_allowed") return 422;
  if (msg === "insufficient_stock") return 409;
  return 500;
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

// ─── POST /movements ─────────────────────────────────────────────────────────
// Atomic inventory movement creation using Firestore transaction.
router.post("/movements", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};

    // --- Validate required fields ---
    const type = String(body.type ?? "").trim();
    const productId = String(body.productId ?? "").trim();
    const warehouseId = String(body.warehouseId ?? "").trim();
    const quantity = Number(body.quantity);
    const date = String(body.date ?? "").trim();
    const locationId = String(body.locationId ?? "").trim();

    if (!type || !["entry", "exit", "transfer", "adjustment"].includes(type)) {
      return res.status(400).json({ error: "validation_error", message: "type is required and must be entry, exit, transfer, or adjustment" });
    }
    if (!productId) {
      return res.status(400).json({ error: "validation_error", message: "productId is required" });
    }
    if (!warehouseId) {
      return res.status(400).json({ error: "validation_error", message: "warehouseId is required" });
    }
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: "validation_error", message: "quantity must be greater than 0" });
    }
    if (!date) {
      return res.status(400).json({ error: "validation_error", message: "date is required" });
    }

    // For transfer: validate warehouseDestinationId
    const warehouseDestinationId = String(body.warehouseDestinationId ?? "").trim();
    if (type === "transfer") {
      if (!warehouseDestinationId) {
        return res.status(400).json({ error: "validation_error", message: "warehouseDestinationId is required for transfer movements" });
      }
      if (warehouseDestinationId === warehouseId) {
        return res.status(400).json({ error: "validation_error", message: "warehouseDestinationId must be different from warehouseId" });
      }
    }

    // --- Extract optional fields ---
    const productName = String(body.productName ?? "").trim();
    const warehouseName = String(body.warehouseName ?? "").trim();
    const warehouseDestinationName = String(body.warehouseDestinationName ?? "").trim();
    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({
        error: "validation_error",
        message: "unitOfMeasureCode is required and must be a valid catalog code",
      });
    }
    const unitFields = unitDenormalizedFirestoreFields(unitRow);
    const reason = normalizeTextForFirestore(body.reason);
    const referenceType = normalizeTextForFirestore(body.referenceType);
    const referenceId = normalizeTextForFirestore(body.referenceId);
    const notes = normalizeTextForFirestore(body.notes);
    const code = normalizeTextForFirestore(body.code);
    const locationName = String(body.locationName ?? "").trim();

    // --- Firestore transaction ---
    const movementRef = db.collection("inventory-movements").doc();
    const stockLevelOriginId = `${productId}_${warehouseId}`;
    const stockLevelOriginRef = db.collection("stock-levels").doc(stockLevelOriginId);

    let stockLevelDestRef: FirebaseFirestore.DocumentReference | null = null;
    if (type === "transfer") {
      const stockLevelDestId = `${productId}_${warehouseDestinationId}`;
      stockLevelDestRef = db.collection("stock-levels").doc(stockLevelDestId);
    }

    await db.runTransaction(async (transaction) => {
      // a. Read current stock-level for origin
      const originSnap = await transaction.get(stockLevelOriginRef);
      const currentStock = originSnap.exists ? (Number(originSnap.data()?.quantity) || 0) : 0;

      // b. Validate stock for exit and transfer (origin)
      if (type === "exit" || type === "transfer") {
        if (currentStock < quantity) {
          throw new Error("insufficient_stock");
        }
      }

      // For adjustment: validate resulting stock won't go below 0
      if (type === "adjustment") {
        const adjustedQuantity = body.adjustmentDirection === "subtract"
          ? currentStock - quantity
          : currentStock + quantity;
        if (adjustedQuantity < 0) {
          throw new Error("insufficient_stock");
        }
      }

      // c. Create the movement document
      const movementDoc: Record<string, unknown> = {
        code,
        type,
        productId,
        productName,
        warehouseId,
        warehouseName,
        quantity,
        ...unitFields,
        reason,
        referenceType,
        referenceId,
        date,
        notes,
        locationId,
        locationName,
        companyId,
        accountId,
        createAt: new Date(),
        createBy: uid,
      };
      if (type === "transfer") {
        movementDoc.warehouseDestinationId = warehouseDestinationId;
        movementDoc.warehouseDestinationName = warehouseDestinationName;
      }
      transaction.set(movementRef, movementDoc);

      // d. Update (or create) stock-level documents
      const now = date; // Use the movement date as lastMovementDate

      if (type === "entry") {
        const newQuantity = currentStock + quantity;
        if (originSnap.exists) {
          transaction.update(stockLevelOriginRef, {
            quantity: newQuantity,
            lastMovementDate: now,
          });
        } else {
          transaction.set(stockLevelOriginRef, {
            productId,
            productName,
            warehouseId,
            warehouseName,
            quantity: newQuantity,
            ...unitFields,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }
      } else if (type === "exit") {
        const newQuantity = currentStock - quantity;
        if (originSnap.exists) {
          transaction.update(stockLevelOriginRef, {
            quantity: newQuantity,
            lastMovementDate: now,
          });
        } else {
          // Should not happen (stock validated above), but handle gracefully
          transaction.set(stockLevelOriginRef, {
            productId,
            productName,
            warehouseId,
            warehouseName,
            quantity: newQuantity,
            ...unitFields,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }
      } else if (type === "transfer") {
        // Decrement at origin
        const newOriginQuantity = currentStock - quantity;
        if (originSnap.exists) {
          transaction.update(stockLevelOriginRef, {
            quantity: newOriginQuantity,
            lastMovementDate: now,
          });
        } else {
          transaction.set(stockLevelOriginRef, {
            productId,
            productName,
            warehouseId,
            warehouseName,
            quantity: newOriginQuantity,
            ...unitFields,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }

        // Increment at destination
        const destSnap = await transaction.get(stockLevelDestRef!);
        const currentDestStock = destSnap.exists ? (Number(destSnap.data()?.quantity) || 0) : 0;
        const newDestQuantity = currentDestStock + quantity;
        if (destSnap.exists) {
          transaction.update(stockLevelDestRef!, {
            quantity: newDestQuantity,
            lastMovementDate: now,
          });
        } else {
          transaction.set(stockLevelDestRef!, {
            productId,
            productName,
            warehouseId: warehouseDestinationId,
            warehouseName: warehouseDestinationName,
            quantity: newDestQuantity,
            ...unitFields,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }
      } else if (type === "adjustment") {
        // Adjustment: add or subtract quantity
        const adjustedQuantity = body.adjustmentDirection === "subtract"
          ? currentStock - quantity
          : currentStock + quantity;
        if (originSnap.exists) {
          transaction.update(stockLevelOriginRef, {
            quantity: adjustedQuantity,
            lastMovementDate: now,
          });
        } else {
          transaction.set(stockLevelOriginRef, {
            productId,
            productName,
            warehouseId,
            warehouseName,
            quantity: adjustedQuantity,
            ...unitFields,
            lastMovementDate: now,
            locationId,
            companyId,
            accountId,
          });
        }
      }
    });

    // Fire-and-forget: update dashboard snapshot
    trackEntityChange(db, { accountId, companyId, collectionName: "inventory-movements", action: "create" }).catch(() => {});

    const productDoc = await db.collection("products").doc(productId).get();
    const pd = productDoc.data() ?? {};
    const stockSku = String(pd.sku ?? pd.code ?? productId).trim();
    const { emit } = await import("../integration/integration-events.js");
    emit({
      companyId,
      accountId,
      type: "stock_updated",
      payload: {
        sku: stockSku,
        productId,
        warehouse: warehouseName,
        movementType: type,
        quantity,
        updatedAt: new Date().toISOString(),
      },
    }).catch(() => {});

    return res.status(201).json({ id: movementRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/movements POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);

    if (msg === "insufficient_stock") {
      const body = req.body ?? {};
      return res.status(409).json({
        error: "insufficient_stock",
        product: String(body.productName ?? "").trim(),
        warehouse: String(body.warehouseName ?? "").trim(),
      });
    }

    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

// ─── GET /stock ──────────────────────────────────────────────────────────────
// Query stock levels filtered by companyId and locationId.
router.get("/stock", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const locationId = String(req.query?.locationId ?? "").trim();

    let query: FirebaseFirestore.Query = db
      .collection("stock-levels")
      .where("companyId", "==", companyId);

    if (locationId) {
      query = query.where("locationId", "==", locationId);
    }

    const snap = await query.get();
    const items = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        productId: String(data.productId ?? ""),
        productName: String(data.productName ?? ""),
        warehouseId: String(data.warehouseId ?? ""),
        warehouseName: String(data.warehouseName ?? ""),
        quantity: Number(data.quantity) || 0,
        ...unitFieldsForApiResponse(data as Record<string, unknown>),
        lastMovementDate: String(data.lastMovementDate ?? ""),
        locationId: String(data.locationId ?? ""),
        companyId: String(data.companyId ?? ""),
        accountId: String(data.accountId ?? ""),
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/stock GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// GET /movements — List inventory movements
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/movements", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const locationId = String(req.query?.locationId ?? "").trim();

    let query: FirebaseFirestore.Query = db
      .collection("inventory-movements")
      .where("companyId", "==", companyId);

    if (locationId) {
      query = query.where("locationId", "==", locationId);
    }

    const snap = await query.get();
    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        code: String(d.code ?? ""),
        type: String(d.type ?? ""),
        productId: String(d.productId ?? ""),
        productName: String(d.productName ?? ""),
        warehouseId: String(d.warehouseId ?? ""),
        warehouseName: String(d.warehouseName ?? ""),
        warehouseDestinationId: d.warehouseDestinationId ? String(d.warehouseDestinationId) : undefined,
        warehouseDestinationName: d.warehouseDestinationName ? String(d.warehouseDestinationName) : undefined,
        quantity: Number(d.quantity) || 0,
        ...unitFieldsForApiResponse(d as Record<string, unknown>),
        reason: d.reason ? String(d.reason) : undefined,
        referenceType: d.referenceType ? String(d.referenceType) : undefined,
        referenceId: d.referenceId ? String(d.referenceId) : undefined,
        date: String(d.date ?? ""),
        notes: d.notes ? String(d.notes) : undefined,
        locationId: String(d.locationId ?? ""),
        locationName: String(d.locationName ?? ""),
        companyId: String(d.companyId ?? ""),
        accountId: String(d.accountId ?? ""),
        createAt: d.createAt ?? null,
        createBy: d.createBy ? String(d.createBy) : undefined,
      };
    });

    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/movements GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCT CATEGORIES CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toProductCategoryRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: String(d.code ?? ""),
    name: String(d.name ?? ""),
    description: d.description ? String(d.description) : undefined,
    parentCategoryId: d.parentCategoryId ? String(d.parentCategoryId) : undefined,
    active: d.active !== false,
    companyId: String(d.companyId ?? ""),
    accountId: String(d.accountId ?? ""),
    createAt: d.createAt ?? null,
    createBy: d.createBy ? String(d.createBy) : undefined,
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ? String(d.updateBy) : undefined,
  };
}

/** GET /inventory/product-categories — List all product categories */
router.get("/product-categories", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("product-categories")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toProductCategoryRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/product-categories GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/product-categories/:id — Get a single product category */
router.get("/product-categories/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("product-categories").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toProductCategoryRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/product-categories/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/product-categories — Create a new product category */
router.post("/product-categories", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "validation_error", message: "name is required" });

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: String(body.code ?? "").trim(),
      name,
      active: body.active !== false,
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };
    const description = body.description ? String(body.description).trim() : "";
    if (description) doc.description = description;
    const parentId = body.parentCategoryId ? String(body.parentCategoryId).trim() : "";
    if (parentId) doc.parentCategoryId = parentId;

    const docRef = db.collection("product-categories").doc();
    await docRef.set(doc);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/product-categories POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/product-categories/:id — Update a product category */
router.put("/product-categories/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("product-categories").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    if (body.code !== undefined) patch.code = String(body.code).trim();
    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.description !== undefined) {
      const trimmed = body.description ? String(body.description).trim() : "";
      patch.description = trimmed ? trimmed : FieldValue.delete();
    }
    if (body.parentCategoryId !== undefined) {
      const trimmed = body.parentCategoryId ? String(body.parentCategoryId).trim() : "";
      patch.parentCategoryId = trimmed ? trimmed : FieldValue.delete();
    }
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("product-categories").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/product-categories/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/product-categories/:id — Delete a product category */
router.delete("/product-categories/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("product-categories").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("product-categories").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/product-categories/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT ATTRIBUTE TYPES CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toVariantAttributeTypeRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: String(d.code ?? ""),
    label: String(d.label ?? ""),
    values: normalizeVariantTypeValues(d.values),
    sortOrder: Number(d.sortOrder) || 0,
    active: d.active !== false,
    companyId: String(d.companyId ?? ""),
    accountId: String(d.accountId ?? ""),
    createAt: d.createAt ?? null,
    createBy: d.createBy ? String(d.createBy) : undefined,
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ? String(d.updateBy) : undefined,
  };
}

/** GET /inventory/variant-attribute-types */
router.get("/variant-attribute-types", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("variant-attribute-types")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toVariantAttributeTypeRecord);
    items.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/variant-attribute-types GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/variant-attribute-types/:id */
router.get("/variant-attribute-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("variant-attribute-types").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toVariantAttributeTypeRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/variant-attribute-types/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/variant-attribute-types */
router.post("/variant-attribute-types", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const code = normalizeVariantTypeCode(body.code);
    const label = String(body.label ?? "").trim();
    if (!code) return res.status(400).json({ error: "validation_error", message: "code is required" });
    if (!VARIANT_ATTRIBUTE_TYPE_CODE_RE.test(code)) {
      return res.status(400).json({
        error: "validation_error",
        message: "code must be lowercase alphanumeric with underscores or hyphens",
      });
    }
    if (!label) return res.status(400).json({ error: "validation_error", message: "label is required" });

    const dup = await db
      .collection("variant-attribute-types")
      .where("companyId", "==", companyId)
      .where("code", "==", code)
      .limit(1)
      .get();
    if (!dup.empty) {
      return res.status(409).json({ error: "duplicate_code", message: `code "${code}" already exists` });
    }

    const docRef = db.collection("variant-attribute-types").doc();
    await docRef.set({
      companyId,
      accountId,
      code,
      label,
      values: normalizeVariantTypeValues(body.values),
      sortOrder: Number(body.sortOrder) || 0,
      active: body.active !== false,
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/variant-attribute-types POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/variant-attribute-types/:id */
router.put("/variant-attribute-types/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("variant-attribute-types").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    if (body.code !== undefined) {
      const code = normalizeVariantTypeCode(body.code);
      if (!code) return res.status(400).json({ error: "validation_error", message: "code is required" });
      if (!VARIANT_ATTRIBUTE_TYPE_CODE_RE.test(code)) {
        return res.status(400).json({
          error: "validation_error",
          message: "code must be lowercase alphanumeric with underscores or hyphens",
        });
      }
      const curCode = normalizeVariantTypeCode(current.data()?.code);
      if (code !== curCode) {
        const dup = await db
          .collection("variant-attribute-types")
          .where("companyId", "==", companyId)
          .where("code", "==", code)
          .limit(1)
          .get();
        if (!dup.empty && dup.docs[0]!.id !== id) {
          return res.status(409).json({ error: "duplicate_code", message: `code "${code}" already exists` });
        }
      }
      patch.code = code;
    }
    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (!label) return res.status(400).json({ error: "validation_error", message: "label is required" });
      patch.label = label;
    }
    if (body.values !== undefined) patch.values = normalizeVariantTypeValues(body.values);
    if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("variant-attribute-types").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/variant-attribute-types/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/variant-attribute-types/:id */
router.delete("/variant-attribute-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("variant-attribute-types").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("variant-attribute-types").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/variant-attribute-types/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toProductRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: String(d.code ?? ""),
    name: String(d.name ?? ""),
    description: d.description ? String(d.description) : undefined,
    categoryId: d.categoryId ? String(d.categoryId) : undefined,
    categoryName: d.categoryName ? String(d.categoryName) : undefined,
    type: String(d.type ?? "good"),
    ...unitFieldsForApiResponse(d as Record<string, unknown>),
    purchasePrice: Number(d.purchasePrice) || 0,
    salePrice: Number(d.salePrice) || 0,
    currency: String(d.currency ?? "PEN"),
    taxAffectation: String(d.taxAffectation ?? "10"),
    minStock: d.minStock != null ? Number(d.minStock) : null,
    maxStock: d.maxStock != null ? Number(d.maxStock) : null,
    active: d.active !== false,
    companyId: String(d.companyId ?? ""),
    accountId: String(d.accountId ?? ""),
    createAt: d.createAt ?? null,
    createBy: d.createBy ? String(d.createBy) : undefined,
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ? String(d.updateBy) : undefined,
    sku: d.sku ? String(d.sku) : undefined,
    ecommerceStatus: String(d.ecommerceStatus ?? "active"),
    imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls.map(String) : [],
    categoryPath: Array.isArray(d.categoryPath) ? d.categoryPath.map(String) : [],
    variantAttributeTypeCodes: parseVariantAttributeTypeCodes(d.variantAttributeTypeCodes),
    variantAttributeLabels: parseVariantAttributeLabels(d.variantAttributeLabels),
    attributeDefinitions:
      d.attributeDefinitions && typeof d.attributeDefinitions === "object" && !Array.isArray(d.attributeDefinitions)
        ? Object.fromEntries(
            Object.entries(d.attributeDefinitions as Record<string, unknown>).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.map(String) : [],
            ])
          )
        : {},
  };
}

/** GET /inventory/products — List all products */
router.get("/products", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("products")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toProductRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/products/:id — Get a single product */
router.get("/products/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("products").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toProductRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/products — Create a new product */
router.post("/products", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "validation_error", message: "name is required" });

    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({
        error: "validation_error",
        message: "unitOfMeasureCode is required and must be a valid catalog code",
      });
    }
    const unitFields = unitDenormalizedFirestoreFields(unitRow);

    const typeCodes = parseVariantAttributeTypeCodes(body.variantAttributeTypeCodes);
    const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
    const typeCodesError = validateVariantAttributeTypeCodes(typeCodes, catalog);
    if (typeCodesError) {
      return res.status(400).json({ error: "validation_error", message: typeCodesError });
    }
    const attributeDefinitions = buildAttributeDefinitions(typeCodes, catalog);
    const variantAttributeLabels = buildVariantAttributeLabels(typeCodes, catalog);

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: String(body.code ?? "").trim(),
      name,
      description: body.description ? String(body.description).trim() : undefined,
      categoryId: body.categoryId ? String(body.categoryId).trim() : undefined,
      categoryName: body.categoryName ? String(body.categoryName).trim() : undefined,
      type: normalizeProductType(body.type),
      ...unitFields,
      purchasePrice: Number(body.purchasePrice) || 0,
      salePrice: Number(body.salePrice) || 0,
      currency,
      taxAffectation: String(body.taxAffectation ?? "10").trim(),
      minStock: body.minStock != null ? Number(body.minStock) : null,
      maxStock: body.maxStock != null ? Number(body.maxStock) : null,
      active: body.active !== false,
      // Campos e-commerce
      sku: normalizeTextForFirestore(body.sku) || String(body.code ?? "").trim(),
      categoryPath: Array.isArray(body.categoryPath) ? body.categoryPath.map(String) : [],
      variantAttributeTypeCodes: typeCodes,
      attributeDefinitions,
      variantAttributeLabels,
      ecommerceStatus: body.ecommerceStatus === "inactive" || body.ecommerceStatus === "discontinued" ? body.ecommerceStatus : "active",
      imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [],
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    const docRef = db.collection("products").doc();
    await docRef.set(doc);
    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "create" }).catch(() => {});
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "create", recordId: docRef.id, fields: { code: String(body.code ?? "").trim(), name, status: body.active !== false ? "active" : "inactive" } }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/products/:id — Update a product */
router.put("/products/:id", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("products").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const textFields = ["code", "name", "description", "categoryId", "categoryName", "taxAffectation", "sku"];
    for (const f of textFields) {
      if (body[f] !== undefined) patch[f] = body[f] ? String(body[f]).trim() : undefined;
    }
    if (body.categoryPath !== undefined) {
      patch.categoryPath = Array.isArray(body.categoryPath) ? body.categoryPath.map(String) : [];
    }
    if (body.variantAttributeTypeCodes !== undefined) {
      const typeCodes = parseVariantAttributeTypeCodes(body.variantAttributeTypeCodes);
      const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
      const typeCodesError = validateVariantAttributeTypeCodes(typeCodes, catalog);
      if (typeCodesError) {
        return res.status(400).json({ error: "validation_error", message: typeCodesError });
      }
      patch.variantAttributeTypeCodes = typeCodes;
      patch.attributeDefinitions = buildAttributeDefinitions(typeCodes, catalog);
      patch.variantAttributeLabels = buildVariantAttributeLabels(typeCodes, catalog);
    }
    if (body.ecommerceStatus !== undefined) {
      patch.ecommerceStatus = body.ecommerceStatus === "inactive" || body.ecommerceStatus === "discontinued" ? body.ecommerceStatus : "active";
    }
    if (body.imageUrls !== undefined) {
      patch.imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [];
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
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    if (body.type !== undefined) patch.type = normalizeProductType(body.type);
    const numericFields = ["purchasePrice", "salePrice"];
    for (const f of numericFields) {
      if (body[f] !== undefined) patch[f] = Number(body[f]) || 0;
    }
    if (body.minStock !== undefined) patch.minStock = body.minStock != null ? Number(body.minStock) : null;
    if (body.maxStock !== undefined) patch.maxStock = body.maxStock != null ? Number(body.maxStock) : null;
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("products").doc(id).update(patch);
    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "update" }).catch(() => {});
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "update", recordId: id, fields: { code: body.code !== undefined ? String(body.code).trim() : undefined, name: body.name !== undefined ? String(body.name).trim() : undefined, status: body.active !== undefined ? (body.active !== false ? "active" : "inactive") : undefined } }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/products/:id — Delete a product */
router.delete("/products/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("products").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("products").doc(id).delete();
    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "delete" }).catch(() => {});
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "delete", recordId: id, fields: {} }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// WAREHOUSES CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toWarehouseRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: String(d.code ?? ""),
    name: String(d.name ?? ""),
    address: d.address ? String(d.address) : undefined,
    district: d.district ? String(d.district) : undefined,
    city: d.city ? String(d.city) : undefined,
    country: d.country ? String(d.country) : undefined,
    ubigeo: d.ubigeo ? String(d.ubigeo) : undefined,
    type: String(d.type ?? "principal"),
    active: d.active !== false,
    locationId: String(d.locationId ?? ""),
    locationName: String(d.locationName ?? ""),
    companyId: String(d.companyId ?? ""),
    accountId: String(d.accountId ?? ""),
    createAt: d.createAt ?? null,
    createBy: d.createBy ? String(d.createBy) : undefined,
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ? String(d.updateBy) : undefined,
  };
}

/** GET /inventory/warehouses — List all warehouses */
router.get("/warehouses", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const locationId = String(req.query?.locationId ?? "").trim();

    let query: FirebaseFirestore.Query = db
      .collection("warehouses")
      .where("companyId", "==", companyId);

    if (locationId) {
      query = query.where("locationId", "==", locationId);
    }

    const snap = await query.get();
    const items = snap.docs.map(toWarehouseRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/warehouses GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/warehouses/:id — Get a single warehouse */
router.get("/warehouses/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("warehouses").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toWarehouseRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/warehouses/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/warehouses — Create a new warehouse */
router.post("/warehouses", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "validation_error", message: "name is required" });

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: String(body.code ?? "").trim(),
      name,
      address: String(body.address ?? "").trim(),
      district: String(body.district ?? "").trim(),
      city: String(body.city ?? "").trim(),
      country: String(body.country ?? "").trim() || "PE",
      ubigeo: String(body.ubigeo ?? "").trim(),
      type: ["principal", "secondary", "transit"].includes(String(body.type ?? "")) ? body.type : "principal",
      active: body.active !== false,
      locationId: String(body.locationId ?? "").trim(),
      locationName: String(body.locationName ?? "").trim(),
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    const docRef = db.collection("warehouses").doc();
    await docRef.set(doc);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/warehouses POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/warehouses/:id — Update a warehouse */
router.put("/warehouses/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("warehouses").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    const textFields = ["code", "name", "address", "district", "city", "country", "ubigeo", "locationId", "locationName"];
    for (const f of textFields) {
      if (body[f] !== undefined) {
        const s = String(body[f] ?? "").trim();
        patch[f] = f === "country" && !s ? "PE" : s;
      }
    }
    if (body.type !== undefined) {
      patch.type = ["principal", "secondary", "transit"].includes(String(body.type)) ? body.type : "principal";
    }
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("warehouses").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/warehouses/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/warehouses/:id — Delete a warehouse */
router.delete("/warehouses/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("warehouses").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("warehouses").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/warehouses/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANTS CRUD — /inventory/products/:productId/variants
// ═══════════════════════════════════════════════════════════════════════════════

function toVariantRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    productId: String(d.productId ?? ""),
    companyId: String(d.companyId ?? ""),
    accountId: String(d.accountId ?? ""),
    sku: String(d.sku ?? ""),
    attributes: normalizeAttributesInput(d.attributes),
    salePrice: Number(d.salePrice) || 0,
    salePricePromo: d.salePricePromo != null ? Number(d.salePricePromo) : null,
    saleStart: d.saleStart ? String(d.saleStart) : undefined,
    saleEnd: d.saleEnd ? String(d.saleEnd) : undefined,
    weightKg: d.weightKg != null ? Number(d.weightKg) : undefined,
    imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls.map(String) : [],
    active: d.active !== false,
    updatedAt: d.updatedAt ?? null,
  };
}

/** GET /inventory/products/:productId/variants */
router.get("/products/:productId/variants", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { productId } = req.params;
    const product = await db.collection("products").doc(productId).get();
    if (!product.exists || String(product.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(404).json({ error: "not_found" });
    }
    const snap = await db.collection("products").doc(productId).collection("variants").get();
    const items = snap.docs.map(toVariantRecord);
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:productId/variants GET] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/products/:productId/variants/:variantId */
router.get("/products/:productId/variants/:variantId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { productId, variantId } = req.params;
    const snap = await db.collection("products").doc(productId).collection("variants").doc(variantId).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toVariantRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:productId/variants/:variantId GET] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/products/:productId/variants */
router.post("/products/:productId/variants", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { productId } = req.params;
    const now = new Date();
    const body = req.body ?? {};
    const product = await db.collection("products").doc(productId).get();
    if (!product.exists || String(product.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(404).json({ error: "not_found" });
    }
    const sku = String(body.sku ?? "").trim();
    const parentSku = String(product.data()?.sku ?? "").trim();
    const skuParentError = validateVariantSkuAgainstParent(parentSku, sku);
    if (skuParentError) {
      return res.status(400).json({ error: "validation_error", message: skuParentError });
    }
    const dup = await db.collection("products").doc(productId).collection("variants")
      .where("sku", "==", sku).where("companyId", "==", companyId).limit(1).get();
    if (!dup.empty) return res.status(409).json({ error: "duplicate_sku", message: `SKU "${sku}" already exists` });

    const productTypeCodes = parseVariantAttributeTypeCodes(product.data()?.variantAttributeTypeCodes);
    const attributes = normalizeAttributesInput(body.attributes);
    if (Object.keys(attributes).length > 0) {
      const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
      const attrError = validateVariantAttributes(attributes, productTypeCodes, catalog);
      if (attrError) {
        return res.status(400).json({ error: "validation_error", message: attrError });
      }
    } else if (productTypeCodes.length > 0 && body.attributes !== undefined) {
      return res.status(400).json({
        error: "validation_error",
        message: "attributes is required when the product has variant attribute types configured",
      });
    }

    const docRef = db.collection("products").doc(productId).collection("variants").doc();
    await db.collection("products").doc(productId).update({ updateAt: now, updateBy: uid });
    await docRef.set({
      productId,
      companyId,
      accountId,
      sku,
      attributes,
      salePrice: Number(body.salePrice) || 0,
      salePricePromo: body.salePricePromo != null ? Number(body.salePricePromo) : null,
      saleStart: body.saleStart ? String(body.saleStart) : "",
      saleEnd: body.saleEnd ? String(body.saleEnd) : "",
      weightKg: body.weightKg != null ? Number(body.weightKg) : null,
      imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [],
      active: body.active !== false,
      updatedAt: now,
    });
    const nowStr = now.toISOString();
    const { emit } = await import("../integration/integration-events.js");
    emit({
      companyId,
      accountId,
      type: "price_updated",
      payload: {
        sku,
        productId,
        variantId: docRef.id,
        sale_price: Number(body.salePrice) || 0,
        sale_price_promo: body.salePricePromo != null ? Number(body.salePricePromo) : null,
        updatedAt: nowStr,
      },
    }).catch(() => {});
    trackEntityChange(db, { accountId, companyId, collectionName: "product-variants", action: "create" }).catch(() => {});
    updateEntitySearchIndex(db, {
      accountId,
      companyId,
      entityId: "product",
      action: "update",
      recordId: productId,
      fields: { code: sku },
    }).catch(() => {});
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:productId/variants POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/products/:productId/variants/:variantId */
router.put("/products/:productId/variants/:variantId", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { productId, variantId } = req.params;
    const now = new Date();
    const body = req.body ?? {};
    const current = await db.collection("products").doc(productId).collection("variants").doc(variantId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const curData = current.data() ?? {};
    if (String(curData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const product = await db.collection("products").doc(productId).get();
    if (!product.exists || String(product.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(404).json({ error: "not_found" });
    }
    const parentSku = String(product.data()?.sku ?? "").trim();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.sku !== undefined) {
      const newSku = String(body.sku).trim();
      const skuParentError = validateVariantSkuAgainstParent(parentSku, newSku);
      if (skuParentError) {
        return res.status(400).json({ error: "validation_error", message: skuParentError });
      }
      const dup = await db
        .collection("products")
        .doc(productId)
        .collection("variants")
        .where("sku", "==", newSku)
        .where("companyId", "==", companyId)
        .get();
      const takenByOther = dup.docs.some((d) => d.id !== variantId);
      if (takenByOther) {
        return res.status(409).json({ error: "duplicate_sku", message: `SKU "${newSku}" already exists` });
      }
      patch.sku = newSku;
    }
    if (body.attributes !== undefined) {
      const productTypeCodes = parseVariantAttributeTypeCodes(product.data()?.variantAttributeTypeCodes);
      const attributes = normalizeAttributesInput(body.attributes);
      if (Object.keys(attributes).length > 0) {
        const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
        const attrError = validateVariantAttributes(attributes, productTypeCodes, catalog);
        if (attrError) {
          return res.status(400).json({ error: "validation_error", message: attrError });
        }
        patch.attributes = attributes;
      } else {
        patch.attributes = {};
      }
    }
    if (body.salePrice !== undefined) patch.salePrice = Number(body.salePrice) || 0;
    if (body.salePricePromo !== undefined) patch.salePricePromo = body.salePricePromo != null ? Number(body.salePricePromo) : null;
    if (body.saleStart !== undefined) patch.saleStart = body.saleStart ? String(body.saleStart) : "";
    if (body.saleEnd !== undefined) patch.saleEnd = body.saleEnd ? String(body.saleEnd) : "";
    if (body.weightKg !== undefined) patch.weightKg = body.weightKg != null ? Number(body.weightKg) : null;
    if (body.imageUrls !== undefined) patch.imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [];
    if (body.active !== undefined) patch.active = body.active !== false;
    await db.collection("products").doc(productId).collection("variants").doc(variantId).update(patch);
    await db.collection("products").doc(productId).update({ updateAt: now, updateBy: uid });
    const nowStr = now.toISOString();
    const finalSku = String(patch.sku ?? curData.sku ?? "");
    const finalSalePrice = Number(patch.salePrice ?? curData.salePrice ?? 0);
    const finalSalePricePromo =
      patch.salePricePromo !== undefined
        ? patch.salePricePromo != null
          ? Number(patch.salePricePromo)
          : null
        : curData.salePricePromo != null
          ? Number(curData.salePricePromo)
          : null;
    const { emit } = await import("../integration/integration-events.js");
    emit({
      companyId,
      accountId,
      type: "price_updated",
      payload: {
        sku: finalSku,
        productId,
        variantId,
        sale_price: finalSalePrice,
        sale_price_promo: finalSalePricePromo,
        updatedAt: nowStr,
      },
    }).catch(() => {});
    trackEntityChange(db, { accountId, companyId, collectionName: "product-variants", action: "update" }).catch(() => {});
    updateEntitySearchIndex(db, {
      accountId,
      companyId,
      entityId: "product",
      action: "update",
      recordId: productId,
      fields: { code: finalSku },
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:productId/variants/:variantId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/products/:productId/variants/:variantId */
router.delete("/products/:productId/variants/:variantId", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { productId, variantId } = req.params;
    const current = await db.collection("products").doc(productId).collection("variants").doc(variantId).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    const data = current.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("products").doc(productId).collection("variants").doc(variantId).delete();
    const now = new Date();
    await db.collection("products").doc(productId).update({ updateAt: now, updateBy: uid });
    trackEntityChange(db, { accountId, companyId, collectionName: "product-variants", action: "delete" }).catch(() => {});
    updateEntitySearchIndex(db, {
      accountId,
      companyId,
      entityId: "product",
      action: "update",
      recordId: productId,
      fields: { code: String(data.sku ?? "") },
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/products/:productId/variants/:variantId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

export default router;

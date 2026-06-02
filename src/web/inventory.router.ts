import { Router } from "express";
import multer from "multer";
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
import {
  FILTERABLE_ATTRIBUTE_TYPE_CODE_RE,
  FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT,
  FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN,
  FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX,
} from "./filterable-attribute-types.types.js";
import {
  parseFilterableAttributes,
  denormalizeFilterableAttributeLabels,
} from "./filterable-attribute-types.helpers.js";

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
    if (parentId) {
      doc.parentCategoryId = parentId;
      const parentSnap = await db.collection("product-categories").doc(parentId).get();
      if (!parentSnap.exists) {
        return res.status(400).json({ error: "validation_error", message: "Parent category not found" });
      }
      const parentData = parentSnap.data() ?? {};
      if (parentData.active === false) {
        return res.status(400).json({ error: "validation_error", message: "Parent category is inactive" });
      }
      let depth = 1;
      let currentId = parentId;
      while (currentId) {
        const ancestor = await db.collection("product-categories").doc(currentId).get();
        if (!ancestor.exists) break;
        const aData = ancestor.data() ?? {};
        currentId = aData.parentCategoryId ? String(aData.parentCategoryId) : "";
        depth++;
        if (depth > 3) {
          return res.status(400).json({ error: "validation_error", message: "Category depth cannot exceed 3 levels" });
        }
      }
    }

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
    const existingData = current.data() ?? {};
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
      if (trimmed && trimmed !== id) {
        const parentSnap = await db.collection("product-categories").doc(trimmed).get();
        if (!parentSnap.exists) {
          return res.status(400).json({ error: "validation_error", message: "Parent category not found" });
        }
        const parentData = parentSnap.data() ?? {};
        if (parentData.active === false) {
          return res.status(400).json({ error: "validation_error", message: "Parent category is inactive" });
        }
        let depth = 1;
        let currentId = trimmed;
        while (currentId) {
          const ancestor = await db.collection("product-categories").doc(currentId).get();
          if (!ancestor.exists) break;
          const aData = ancestor.data() ?? {};
          currentId = aData.parentCategoryId ? String(aData.parentCategoryId) : "";
          depth++;
          if (depth > 3) {
            return res.status(400).json({ error: "validation_error", message: "Category depth cannot exceed 3 levels" });
          }
        }
      }
    }
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("product-categories").doc(id).update(patch);

    // If the name changed, propagate to categoryPath of affected products
    if (body.name !== undefined && body.name.trim() !== existingData.name) {
      const allCategories = await db.collection("product-categories")
        .where("companyId", "==", companyId)
        .get();
      const catMap = new Map<string, any>();
      allCategories.docs.forEach(d => catMap.set(d.id, { id: d.id, ...d.data() }));

      const getDescendantIds = (parentId: string): string[] => {
        const ids: string[] = [parentId];
        for (const [cid, cat] of catMap) {
          if (cat.parentCategoryId === parentId) {
            ids.push(...getDescendantIds(cid));
          }
        }
        return ids;
      };
      const affectedIds = getDescendantIds(id);

      const productsSnap = await db.collection("products")
        .where("companyId", "==", companyId)
        .get();

      const batch = db.batch();
      for (const prodDoc of productsSnap.docs) {
        const prodData = prodDoc.data();
        const prodCategoryIds: string[] = prodData.categoryIds || [];
        const intersection = prodCategoryIds.filter((cid: string) => affectedIds.includes(cid));
        if (intersection.length === 0) continue;

        const primaryId = prodCategoryIds[0];
        const newPath: string[] = [];
        let currentCat = catMap.get(primaryId);
        if (currentCat) {
          const chain: any[] = [];
          while (currentCat) {
            chain.unshift(currentCat);
            currentCat = currentCat.parentCategoryId ? catMap.get(currentCat.parentCategoryId) : null;
          }
          newPath.push(...chain.map(c => c.name || ""));
        }
        batch.update(prodDoc.ref, { categoryPath: newPath });
      }
      await batch.commit();
    }

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
    const productWithCategory = await db.collection("products")
      .where("categoryId", "==", id)
      .where("companyId", "==", companyId)
      .limit(1)
      .get();
    if (!productWithCategory.empty) {
      return res.status(400).json({ error: "validation_error", message: "Cannot delete category assigned to one or more products" });
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
// FILTERABLE ATTRIBUTE TYPES CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function toFilterableAttributeTypeRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: String(d.code ?? ""),
    label: String(d.label ?? ""),
    values: Array.isArray(d.values) ? d.values.map((v: unknown) => String(v ?? "")).filter((v: string) => v !== "") : [],
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

function validateFilterableAttributeTypeValues(values: unknown): { valid: boolean; error?: string; normalized?: string[] } {
  if (!Array.isArray(values)) return { valid: false, error: "values must be an array" };
  if (values.length > FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT) {
    return { valid: false, error: `values must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_VALUES_MAX_COUNT} items` };
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    if (v.length > FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH) {
      return { valid: false, error: `each value must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_VALUE_MAX_LENGTH} characters` };
    }
    if (seen.has(v)) {
      return { valid: false, error: `duplicate value "${v}" in values array` };
    }
    seen.add(v);
    normalized.push(v);
  }
  return { valid: true, normalized };
}

function validateFilterableAttributeTypeSortOrder(sortOrder: unknown): { valid: boolean; value: number; error?: string } {
  const n = Number(sortOrder);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { valid: false, value: 0, error: "sortOrder must be an integer" };
  }
  if (n < FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN || n > FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX) {
    return { valid: false, value: 0, error: `sortOrder must be between ${FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MIN} and ${FILTERABLE_ATTRIBUTE_TYPE_SORT_ORDER_MAX}` };
  }
  return { valid: true, value: n };
}

/** GET /inventory/filterable-attribute-types */
router.get("/filterable-attribute-types", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("filterable-attribute-types")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toFilterableAttributeTypeRecord);
    items.sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/filterable-attribute-types GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** GET /inventory/filterable-attribute-types/:id */
router.get("/filterable-attribute-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("filterable-attribute-types").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toFilterableAttributeTypeRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/filterable-attribute-types/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** POST /inventory/filterable-attribute-types */
router.post("/filterable-attribute-types", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};

    // Validate code
    const code = String(body.code ?? "").trim().toLowerCase();
    if (!code) return res.status(400).json({ error: "validation_error", message: "code is required" });
    if (code.length > FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH) {
      return res.status(400).json({ error: "validation_error", message: `code must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_CODE_MAX_LENGTH} characters` });
    }
    if (!FILTERABLE_ATTRIBUTE_TYPE_CODE_RE.test(code)) {
      return res.status(400).json({
        error: "validation_error",
        message: "code must be lowercase alphanumeric with underscores or hyphens",
      });
    }

    // Validate label
    const label = String(body.label ?? "").trim();
    if (!label) return res.status(400).json({ error: "validation_error", message: "label is required" });
    if (label.length > FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH) {
      return res.status(400).json({ error: "validation_error", message: `label must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH} characters` });
    }

    // Validate values
    const valResult = validateFilterableAttributeTypeValues(body.values);
    if (!valResult.valid) {
      return res.status(400).json({ error: "validation_error", message: valResult.error });
    }

    // Validate sortOrder
    const sortResult = validateFilterableAttributeTypeSortOrder(body.sortOrder);
    if (!sortResult.valid) {
      return res.status(400).json({ error: "validation_error", message: sortResult.error });
    }

    // Check code uniqueness within company
    const dup = await db
      .collection("filterable-attribute-types")
      .where("companyId", "==", companyId)
      .where("code", "==", code)
      .limit(1)
      .get();
    if (!dup.empty) {
      return res.status(409).json({ error: "duplicate_code", message: `code "${code}" already exists` });
    }

    const docRef = db.collection("filterable-attribute-types").doc();
    const docData: Record<string, unknown> = {
      companyId,
      accountId,
      code,
      label,
      values: valResult.normalized ?? [],
      sortOrder: sortResult.value,
      active: body.active !== false,
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };
    await docRef.set(docData);

    // Hooks: search index + entity change tracking
    updateEntitySearchIndex(db, {
      accountId,
      companyId,
      entityId: "filterable-attribute-type",
      action: "create",
      recordId: docRef.id,
      fields: { code, label },
    }).catch(() => {});
    trackEntityChange(db, { accountId, companyId, collectionName: "filterable-attribute-types", action: "create" }).catch(() => {});

    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/filterable-attribute-types POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** PUT /inventory/filterable-attribute-types/:id */
router.put("/filterable-attribute-types/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("filterable-attribute-types").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now, updateBy: uid };

    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (!label) return res.status(400).json({ error: "validation_error", message: "label is required" });
      if (label.length > FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH) {
        return res.status(400).json({ error: "validation_error", message: `label must not exceed ${FILTERABLE_ATTRIBUTE_TYPE_LABEL_MAX_LENGTH} characters` });
      }
      patch.label = label;
    }
    if (body.values !== undefined) {
      const valResult = validateFilterableAttributeTypeValues(body.values);
      if (!valResult.valid) {
        return res.status(400).json({ error: "validation_error", message: valResult.error });
      }
      patch.values = valResult.normalized ?? [];
    }
    if (body.sortOrder !== undefined) {
      const sortResult = validateFilterableAttributeTypeSortOrder(body.sortOrder);
      if (!sortResult.valid) {
        return res.status(400).json({ error: "validation_error", message: sortResult.error });
      }
      patch.sortOrder = sortResult.value;
    }
    if (body.active !== undefined) patch.active = body.active !== false;

    await db.collection("filterable-attribute-types").doc(id).update(patch);

    // Propagate label change to all products referencing this type's code
    if (patch.label !== undefined) {
      const typeCode = String(currentData.code ?? "").trim().toLowerCase();
      if (typeCode) {
        const productsSnap = await db
          .collection("products")
          .where("companyId", "==", companyId)
          .where(`filterableAttributes.${typeCode}`, "!=", null)
          .get();

        if (!productsSnap.empty) {
          // Firestore batch limit is 500 operations; chunk if needed
          const BATCH_LIMIT = 500;
          const docs = productsSnap.docs;
          for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
            const chunk = docs.slice(i, i + BATCH_LIMIT);
            const batch = db.batch();
            for (const prodDoc of chunk) {
              batch.update(prodDoc.ref, {
                [`filterableAttributeLabels.${typeCode}`]: patch.label,
              });
            }
            await batch.commit();
          }
        }
      }
    }

    // Hooks: search index + entity change tracking
    const finalLabel = patch.label !== undefined ? String(patch.label) : String(currentData.label ?? "");
    const finalCode = String(currentData.code ?? "");
    updateEntitySearchIndex(db, {
      accountId: String(currentData.accountId ?? ""),
      companyId,
      entityId: "filterable-attribute-type",
      action: "update",
      recordId: id,
      fields: { code: finalCode, label: finalLabel },
    }).catch(() => {});
    trackEntityChange(db, { accountId: String(currentData.accountId ?? ""), companyId, collectionName: "filterable-attribute-types", action: "update" }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/filterable-attribute-types/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

/** DELETE /inventory/filterable-attribute-types/:id */
router.delete("/filterable-attribute-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("filterable-attribute-types").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Check if the type is assigned to any product (reject with 409 if so)
    const typeCode = String(currentData.code ?? "").trim();
    if (typeCode) {
      const productsUsingType = await db
        .collection("products")
        .where("companyId", "==", companyId)
        .where(`filterableAttributes.${typeCode}`, "!=", null)
        .limit(1)
        .get();
      if (!productsUsingType.empty) {
        // Count total products using this type for the error message
        const countSnap = await db
          .collection("products")
          .where("companyId", "==", companyId)
          .where(`filterableAttributes.${typeCode}`, "!=", null)
          .get();
        const count = countSnap.size;
        return res.status(409).json({
          error: "type_in_use",
          message: `Cannot delete: type is assigned to ${count} product(s)`,
        });
      }
    }

    await db.collection("filterable-attribute-types").doc(id).delete();

    // Hooks: search index + entity change tracking
    const accountId = String(currentData.accountId ?? "");
    updateEntitySearchIndex(db, {
      accountId,
      companyId,
      entityId: "filterable-attribute-type",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
    trackEntityChange(db, { accountId, companyId, collectionName: "filterable-attribute-types", action: "delete" }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/inventory/filterable-attribute-types/:id DELETE] failed:", msg);
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
    woocommerceType: String(d.woocommerceType ?? "simple"),
    visibleInStore: d.visibleInStore === true,
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    categoryIds: Array.isArray(d.categoryIds) ? d.categoryIds.map(String) : [],
    groupedProductIds: Array.isArray(d.groupedProductIds) ? d.groupedProductIds.map(String) : [],
    filterableAttributes:
      d.filterableAttributes && typeof d.filterableAttributes === "object" && !Array.isArray(d.filterableAttributes)
        ? d.filterableAttributes
        : {},
    filterableAttributeLabels:
      d.filterableAttributeLabels && typeof d.filterableAttributeLabels === "object" && !Array.isArray(d.filterableAttributeLabels)
        ? d.filterableAttributeLabels
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

    // Filterable attributes: parse input and denormalize labels
    const filterableAttributes = parseFilterableAttributes(body.filterableAttributes);
    const filterableAttributeLabels = await denormalizeFilterableAttributeLabels(db, companyId, accountId, filterableAttributes);

    const doc: Record<string, unknown> = {
      companyId,
      accountId,
      code: String(body.code ?? "").trim(),
      name,
      description: normalizeTextForFirestore(body.description),
      categoryId: normalizeTextForFirestore(body.categoryId),
      categoryName: normalizeTextForFirestore(body.categoryName),
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
      filterableAttributes,
      filterableAttributeLabels,
      ecommerceStatus: body.ecommerceStatus === "inactive" || body.ecommerceStatus === "discontinued" ? body.ecommerceStatus : "active",
      imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [],
      woocommerceType: String(body.woocommerceType ?? "simple").trim(),
      visibleInStore: body.visibleInStore === true,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      categoryIds: Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [],
      groupedProductIds: Array.isArray(body.groupedProductIds) ? body.groupedProductIds.map(String) : [],
      createAt: now,
      createBy: uid,
      updateAt: now,
      updateBy: uid,
    };

    // --- E-commerce validations ---
    const wcType = String(body.woocommerceType ?? "simple").trim();
    const validWoocommerceTypes = ["simple", "grouped", "external", "variable"];
    if (!validWoocommerceTypes.includes(wcType)) {
      return res.status(400).json({ error: "validation_error", message: "woocommerceType must be one of: simple, grouped, external, variable" });
    }
    const visibleInStore = body.visibleInStore === true;
    if (visibleInStore) {
      if (!normalizeTextForFirestore(body.sku)) {
        return res.status(400).json({ error: "validation_error", message: "sku is required when visibleInStore is true" });
      }
      if (!name) {
        return res.status(400).json({ error: "validation_error", message: "name is required when visibleInStore is true" });
      }
      const categoryPath = Array.isArray(body.categoryPath) ? body.categoryPath.map(String) : [];
      if (!categoryPath.length) {
        return res.status(400).json({ error: "validation_error", message: "categoryPath is required when visibleInStore is true" });
      }
      if (wcType !== "grouped") {
        const salePrice = Number(body.salePrice) || 0;
        if (!(salePrice > 0)) {
          return res.status(400).json({ error: "validation_error", message: "salePrice must be greater than 0 when visibleInStore is true and woocommerceType is not grouped" });
        }
      }
    }

    // Validate SKU uniqueness across company
    const skuVal = normalizeTextForFirestore(body.sku) || String(body.code ?? "").trim();
    if (skuVal) {
      const skuDup = await db.collection("products")
        .where("sku", "==", skuVal)
        .where("companyId", "==", companyId)
        .limit(1)
        .get();
      if (!skuDup.empty) {
        return res.status(409).json({ error: "duplicate_sku", message: `SKU "${skuVal}" already exists` });
      }
    }

    // Validate groupedProductIds
    if (wcType === "grouped") {
      const groupedIds = Array.isArray(body.groupedProductIds) ? body.groupedProductIds.map(String) : [];
      if (groupedIds.length > 0) {
        const simpleSnap = await db.collection("products")
          .where("companyId", "==", companyId)
          .where("woocommerceType", "==", "simple")
          .get();
        const simpleIds = new Set(simpleSnap.docs.map(d => d.id));
        for (const gid of groupedIds) {
          if (!simpleIds.has(gid)) {
            return res.status(400).json({ error: "validation_error", message: `groupedProductId "${gid}" is not a valid simple product` });
          }
        }
      }
    }

    const docRef = db.collection("products").doc();
    await docRef.set(doc);
    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "create" }).catch(() => {});
    const idxFields: Record<string, string> = {
      code: normalizeText(doc.code) ?? "",
      name: normalizeText(doc.name) ?? "",
      sku: normalizeText(doc.sku) ?? "",
      ecommerceStatus: String(doc.ecommerceStatus ?? ""),
      woocommerceType: String(doc.woocommerceType ?? ""),
      visibleInStore: doc.visibleInStore ? "1" : "0",
      tags: Array.isArray(doc.tags) ? doc.tags.join(" ") : "",
    };
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "create", recordId: docRef.id, fields: idxFields }).catch(() => {});
    const { emit: emitProduct } = await import("../integration/integration-events.js");
    emitProduct({
      companyId, accountId,
      type: "product_changed",
      payload: {
        sku: doc.sku || "",
        action: "created",
        product_id: docRef.id,
        timestamp: new Date().toISOString(),
      },
    }).catch(() => {});
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

    const textFields = ["code", "name", "categoryId", "categoryName", "taxAffectation", "sku"];
    for (const f of textFields) {
      if (body[f] !== undefined) patch[f] = normalizeTextForFirestore(body[f]);
    }
    if (body.description !== undefined) {
      patch.description = normalizeTextForFirestore(body.description);
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
    if (body.filterableAttributes !== undefined) {
      const filterableAttributes = parseFilterableAttributes(body.filterableAttributes);
      patch.filterableAttributes = filterableAttributes;
      patch.filterableAttributeLabels = await denormalizeFilterableAttributeLabels(db, companyId, accountId, filterableAttributes);
    }
    if (body.ecommerceStatus !== undefined) {
      patch.ecommerceStatus = body.ecommerceStatus === "inactive" || body.ecommerceStatus === "discontinued" ? body.ecommerceStatus : "active";
    }
    if (body.imageUrls !== undefined) {
      patch.imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [];
    }
    if (body.woocommerceType !== undefined) {
      const wt = String(body.woocommerceType).trim();
      const validWoocommerceTypes = ["simple", "grouped", "external", "variable"];
      if (!validWoocommerceTypes.includes(wt)) {
        return res.status(400).json({ error: "validation_error", message: "woocommerceType must be one of: simple, grouped, external, variable" });
      }
      patch.woocommerceType = wt;
    }
    if (body.visibleInStore !== undefined) patch.visibleInStore = body.visibleInStore === true;
    if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
    if (body.categoryIds !== undefined) patch.categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [];
    if (body.groupedProductIds !== undefined) {
      patch.groupedProductIds = Array.isArray(body.groupedProductIds) ? body.groupedProductIds.map(String) : [];
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

    // --- E-commerce PUT validations ---
    const currentData = current.data() ?? {};
    const finalVisibleInStore = body.visibleInStore !== undefined ? body.visibleInStore === true : (currentData.visibleInStore === true);
    if (finalVisibleInStore) {
      const finalSku = patch.sku !== undefined ? String(patch.sku).trim() : String(currentData.sku ?? "").trim();
      if (!finalSku) {
        return res.status(400).json({ error: "validation_error", message: "sku is required when visibleInStore is true" });
      }
      const finalName = patch.name !== undefined ? String(patch.name).trim() : String(currentData.name ?? "").trim();
      if (!finalName) {
        return res.status(400).json({ error: "validation_error", message: "name is required when visibleInStore is true" });
      }
      const finalCategoryPath = patch.categoryPath !== undefined ? (Array.isArray(patch.categoryPath) ? patch.categoryPath.map(String) : []) : (Array.isArray(currentData.categoryPath) ? currentData.categoryPath.map(String) : []);
      if (!finalCategoryPath.length) {
        return res.status(400).json({ error: "validation_error", message: "categoryPath is required when visibleInStore is true" });
      }
      const finalWcType = patch.woocommerceType !== undefined ? String(patch.woocommerceType) : String(currentData.woocommerceType ?? "simple");
      if (finalWcType !== "grouped") {
        const finalSalePrice = patch.salePrice !== undefined ? Number(patch.salePrice) : (Number(currentData.salePrice) || 0);
        if (!(finalSalePrice > 0)) {
          return res.status(400).json({ error: "validation_error", message: "salePrice must be greater than 0 when visibleInStore is true and woocommerceType is not grouped" });
        }
      }
    }

    // Validate SKU uniqueness
    if (body.sku !== undefined) {
      const newSku = String(body.sku).trim();
      if (newSku) {
        const skuDup = await db.collection("products")
          .where("sku", "==", newSku)
          .where("companyId", "==", companyId)
          .get();
        const takenByOther = skuDup.docs.some(d => d.id !== id);
        if (takenByOther) {
          return res.status(409).json({ error: "duplicate_sku", message: `SKU "${newSku}" already exists` });
        }
      }
    }

    // Validate groupedProductIds
    const finalWcType = patch.woocommerceType !== undefined ? String(patch.woocommerceType) : String(currentData.woocommerceType ?? "simple");
    if (finalWcType === "grouped") {
      const finalGroupedIds = patch.groupedProductIds !== undefined ? (Array.isArray(patch.groupedProductIds) ? patch.groupedProductIds.map(String) : []) : (Array.isArray(currentData.groupedProductIds) ? currentData.groupedProductIds.map(String) : []);
      if (finalGroupedIds.length > 0) {
        const simpleSnap = await db.collection("products")
          .where("companyId", "==", companyId)
          .where("woocommerceType", "==", "simple")
          .get();
        const simpleIds = new Set(simpleSnap.docs.map(d => d.id));
        for (const gid of finalGroupedIds) {
          if (!simpleIds.has(gid)) {
            return res.status(400).json({ error: "validation_error", message: `groupedProductId "${gid}" is not a valid simple product` });
          }
        }
      }
    }

    // If woocommerceType changed from simple to something else, remove from grouped parents
    if (currentData.woocommerceType === "simple" && finalWcType !== "simple") {
      const groupedParents = await db.collection("products")
        .where("companyId", "==", companyId)
        .where("groupedProductIds", "array-contains", id)
        .get();
      if (!groupedParents.empty) {
        const batch = db.batch();
        for (const doc of groupedParents.docs) {
          const currentIds: string[] = doc.data().groupedProductIds || [];
          batch.update(doc.ref, {
            groupedProductIds: currentIds.filter((pid: string) => pid !== id),
          });
        }
        await batch.commit();
      }
    }

    await db.collection("products").doc(id).update(patch);
    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "update" }).catch(() => {});
    const fCode = patch.code !== undefined ? String(patch.code).trim() : String(currentData.code ?? "").trim();
    const fName = patch.name !== undefined ? String(patch.name).trim() : String(currentData.name ?? "").trim();
    const fSku = patch.sku !== undefined ? String(patch.sku).trim() : String(currentData.sku ?? "").trim();
    const fEcommerceStatus = patch.ecommerceStatus !== undefined ? String(patch.ecommerceStatus) : String(currentData.ecommerceStatus ?? "active");
    const fWoocommerceType = patch.woocommerceType !== undefined ? String(patch.woocommerceType) : String(currentData.woocommerceType ?? "simple");
    const fVisibleInStore = patch.visibleInStore !== undefined ? patch.visibleInStore === true : (currentData.visibleInStore === true);
    const fTags = patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags : []) : (Array.isArray(currentData.tags) ? currentData.tags : []);
    const updFields: Record<string, string> = {
      code: normalizeText(fCode) ?? "",
      name: normalizeText(fName) ?? "",
      sku: normalizeText(fSku) ?? "",
      ecommerceStatus: String(fEcommerceStatus ?? ""),
      woocommerceType: String(fWoocommerceType ?? ""),
      visibleInStore: fVisibleInStore ? "1" : "0",
      tags: Array.isArray(fTags) ? fTags.join(" ") : "",
    };
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "update", recordId: id, fields: updFields }).catch(() => {});
    const { emit: emitProduct } = await import("../integration/integration-events.js");
    console.log(`[inventory PUT] product ${id}: fVisibleInStore=${fVisibleInStore}, currentData.visibleInStore=${currentData.visibleInStore}`);
    if (fVisibleInStore || currentData.visibleInStore === true) {
      emitProduct({
        companyId, accountId,
        type: "product_changed",
        payload: {
          sku: fSku || "",
          action: "updated",
          product_id: id,
          timestamp: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    if (currentData.visibleInStore === true && !fVisibleInStore) {
      emitProduct({
        companyId, accountId,
        type: "product_changed",
        payload: {
          sku: fSku || "",
          action: "unpublished",
          product_id: id,
          timestamp: new Date().toISOString(),
        },
      }).catch(() => {});
    }
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
    const productData = current.data() ?? {};
    await db.collection("products").doc(id).delete();

    // Remove this product from any groupedProductIds arrays
    const groupedParents = await db.collection("products")
      .where("companyId", "==", companyId)
      .where("groupedProductIds", "array-contains", id)
      .get();
    if (!groupedParents.empty) {
      const batch = db.batch();
      for (const doc of groupedParents.docs) {
        const currentIds: string[] = doc.data().groupedProductIds || [];
        batch.update(doc.ref, {
          groupedProductIds: currentIds.filter((pid: string) => pid !== id),
        });
      }
      await batch.commit();
    }

    trackEntityChange(db, { accountId, companyId, collectionName: "products", action: "delete" }).catch(() => {});
    updateEntitySearchIndex(db, { accountId, companyId, entityId: "product", action: "delete", recordId: id, fields: {} }).catch(() => {});
    const { emit: emitProduct } = await import("../integration/integration-events.js");
    emitProduct({
      companyId, accountId,
      type: "product_changed",
      payload: {
        sku: String(productData.sku || ""),
        action: "deleted",
        product_id: id,
        timestamp: new Date().toISOString(),
      },
    }).catch(() => {});
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
    const productData = product.data() ?? {};
    if (String(productData.woocommerceType ?? "simple").trim() === "grouped") {
      return res.status(400).json({ error: "validation_error", message: "Cannot create variants for a grouped product" });
    }
    const sku = String(body.sku ?? "").trim();
    if (!sku) {
      return res.status(400).json({ error: "validation_error", message: "Variant SKU is required" });
    }
    const parentSku = String(productData.sku ?? "").trim();
    const skuParentError = validateVariantSkuAgainstParent(parentSku, sku);
    if (skuParentError) {
      return res.status(400).json({ error: "validation_error", message: skuParentError });
    }
    // Check uniqueness across all products in company
    const productSkuDup = await db.collection("products")
      .where("sku", "==", sku)
      .where("companyId", "==", companyId)
      .limit(1)
      .get();
    if (!productSkuDup.empty) {
      return res.status(409).json({ error: "duplicate_sku", message: `SKU "${sku}" is already used by another product` });
    }
    // Check uniqueness across all variants in company
    const variantSkuDup = await db.collectionGroup("variants")
      .where("sku", "==", sku)
      .where("companyId", "==", companyId)
      .limit(1)
      .get();
    if (!variantSkuDup.empty) {
      return res.status(409).json({ error: "duplicate_sku", message: `SKU "${sku}" is already used by another variant` });
    }
    // Check uniqueness within this product's variants
    const dup = await db.collection("products").doc(productId).collection("variants")
      .where("sku", "==", sku).where("companyId", "==", companyId).limit(1).get();
    if (!dup.empty) return res.status(409).json({ error: "duplicate_sku", message: `SKU "${sku}" already exists` });

    const productTypeCodes = parseVariantAttributeTypeCodes(productData.variantAttributeTypeCodes);
    const attributes = normalizeAttributesInput(body.attributes);
    if (productTypeCodes.length > 0) {
      const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
      // Validate all required attribute codes are present
      for (const code of productTypeCodes) {
        if (!(code in attributes) || !attributes[code]) {
          return res.status(400).json({ error: "validation_error", message: `Attribute "${code}" is required` });
        }
      }
      const attrError = validateVariantAttributes(attributes, productTypeCodes, catalog);
      if (attrError) {
        return res.status(400).json({ error: "validation_error", message: attrError });
      }
    }

    // Validate no duplicate attribute combination
    const existingVariants = await db.collection("products").doc(productId).collection("variants").get();
    const attrKey = JSON.stringify(Object.entries(attributes).sort());
    for (const vDoc of existingVariants.docs) {
      const vData = vDoc.data();
      const vAttr = normalizeAttributesInput(vData.attributes);
      const vKey = JSON.stringify(Object.entries(vAttr).sort());
      if (vKey === attrKey) {
        return res.status(400).json({ error: "validation_error", message: "A variant with the same attribute combination already exists" });
      }
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
    const productData = product.data() ?? {};
    if (String(productData.woocommerceType ?? "simple").trim() === "grouped") {
      return res.status(400).json({ error: "validation_error", message: "Cannot create variants for a grouped product" });
    }
    const parentSku = String(productData.sku ?? "").trim();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.sku !== undefined) {
      const newSku = String(body.sku).trim();
      if (!newSku) {
        return res.status(400).json({ error: "validation_error", message: "Variant SKU is required" });
      }
      const skuParentError = validateVariantSkuAgainstParent(parentSku, newSku);
      if (skuParentError) {
        return res.status(400).json({ error: "validation_error", message: skuParentError });
      }
      // Check uniqueness across all products in company
      const productSkuDup = await db.collection("products")
        .where("sku", "==", newSku)
        .where("companyId", "==", companyId)
        .limit(1)
        .get();
      if (!productSkuDup.empty) {
        return res.status(409).json({ error: "duplicate_sku", message: `SKU "${newSku}" is already used by another product` });
      }
      // Check uniqueness across all variants in company
      const variantSkuDup = await db.collectionGroup("variants")
        .where("sku", "==", newSku)
        .where("companyId", "==", companyId)
        .limit(1)
        .get();
      const takenByOtherVariant = variantSkuDup.docs.some((d) => d.id !== variantId);
      if (takenByOtherVariant) {
        return res.status(409).json({ error: "duplicate_sku", message: `SKU "${newSku}" is already used by another variant` });
      }
      // Check uniqueness within this product's variants
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
      const productTypeCodes = parseVariantAttributeTypeCodes(productData.variantAttributeTypeCodes);
      const attributes = normalizeAttributesInput(body.attributes);
      if (productTypeCodes.length > 0) {
        const catalog = await loadVariantAttributeTypesByCode(db, companyId, accountId);
        for (const code of productTypeCodes) {
          if (!(code in attributes) || !attributes[code]) {
            return res.status(400).json({ error: "validation_error", message: `Attribute "${code}" is required` });
          }
        }
        const attrError = validateVariantAttributes(attributes, productTypeCodes, catalog);
        if (attrError) {
          return res.status(400).json({ error: "validation_error", message: attrError });
        }
        patch.attributes = attributes;
      } else {
        patch.attributes = attributes;
      }
    }
    if (body.salePrice !== undefined) patch.salePrice = Number(body.salePrice) || 0;
    if (body.salePricePromo !== undefined) patch.salePricePromo = body.salePricePromo != null ? Number(body.salePricePromo) : null;
    if (body.saleStart !== undefined) patch.saleStart = body.saleStart ? String(body.saleStart) : "";
    if (body.saleEnd !== undefined) patch.saleEnd = body.saleEnd ? String(body.saleEnd) : "";
    if (body.weightKg !== undefined) patch.weightKg = body.weightKg != null ? Number(body.weightKg) : null;
    if (body.imageUrls !== undefined) patch.imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.map(String) : [];
    if (body.active !== undefined) patch.active = body.active !== false;

    // Validate no duplicate attribute combination
    if (patch.attributes !== undefined) {
      const finalAttrs = patch.attributes as Record<string, string>;
      const attrKey = JSON.stringify(Object.entries(finalAttrs).sort());
      const existingVariants = await db.collection("products").doc(productId).collection("variants").get();
      for (const vDoc of existingVariants.docs) {
        if (vDoc.id === variantId) continue;
        const vData = vDoc.data();
        const vAttr = normalizeAttributesInput(vData.attributes);
        const vKey = JSON.stringify(Object.entries(vAttr).sort());
        if (vKey === attrKey) {
          return res.status(400).json({ error: "validation_error", message: "A variant with the same attribute combination already exists" });
        }
      }
    }

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

// ─── Image Upload ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de archivo no permitido. Use jpg, png o webp."));
    }
  },
});

const IMAGE_PATH_RE = /^companies\/[^/]+\/products\/[^/]+\/images\//;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** POST /inventory/products/:id/images — Subir imagen de producto */
router.post("/products/:id/images", upload.single("file"), async (req, res) => {
  try {
    const { companyId } = req.body as { companyId?: string };
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file is required" });
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: "Tipo de archivo no permitido. Use jpg, png o webp." });
    }
    const { getWebStorage } = await import("../lib/firebase-admin.js");
    const timestamp = Date.now();
    const filename = `${timestamp}_${file.originalname}`;
    const storagePath = `companies/${companyId}/products/${req.params.id}/images/${filename}`;
    const bucket = getWebStorage();
    const blob = bucket.file(storagePath);
    await blob.save(file.buffer, {
      metadata: { contentType: file.mimetype },
    });
    await blob.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    return res.status(200).json({ url: publicUrl, path: storagePath, filename });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[image upload] failed:", msg);
    return res.status(500).json({ error: msg });
  }
});

/** POST /inventory/products/:id/variants/:variantId/images — Subir imagen de variante */
router.post("/products/:id/variants/:variantId/images", upload.single("file"), async (req, res) => {
  try {
    const { companyId } = req.body as { companyId?: string };
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file is required" });
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: "Tipo de archivo no permitido. Use jpg, png o webp." });
    }
    const { getWebStorage } = await import("../lib/firebase-admin.js");
    const timestamp = Date.now();
    const filename = `${timestamp}_${file.originalname}`;
    const storagePath = `companies/${companyId}/products/${req.params.id}/variants/${req.params.variantId}/images/${filename}`;
    const bucket = getWebStorage();
    const blob = bucket.file(storagePath);
    await blob.save(file.buffer, {
      metadata: { contentType: file.mimetype },
    });
    await blob.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    return res.status(200).json({ url: publicUrl, path: storagePath, filename });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[variant image upload] failed:", msg);
    return res.status(500).json({ error: msg });
  }
});

/** DELETE /inventory/products/:id/images — Eliminar imagen por storagePath */
router.delete("/products/:id/images", async (req, res) => {
  try {
    const { storagePath } = req.body as { storagePath?: string };
    if (!storagePath || !IMAGE_PATH_RE.test(storagePath)) {
      return res.status(400).json({ error: "storagePath inválido" });
    }
    const { getWebStorage } = await import("../lib/firebase-admin.js");
    const bucket = getWebStorage();
    await bucket.file(storagePath).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[image delete] failed:", msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;

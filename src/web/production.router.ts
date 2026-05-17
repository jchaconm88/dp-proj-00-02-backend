import { Router } from "express";
import { getWebFirestore } from "../lib/firebase-admin.js";
import { generateSequenceCode } from "../lib/sequences.service.js";
import { trackEntityChange, trackMetric } from "../features/dashboard/snapshot-incremental.service.js";
import { updateEntitySearchIndex } from "../features/search/entity-search-index.service.js";
import {
  resolveUnitOfMeasureFromBody,
  unitDenormalizedFirestoreFields,
  unitFieldsForApiResponse,
} from "../data/units-of-measure.js";
import { FieldValue } from "firebase-admin/firestore";

const router = Router();

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

function movementDateIso(): string {
  return new Date().toISOString().split("T")[0]!;
}

function unitFirestoreFromMaterial(mat: Record<string, unknown>): Record<string, string> {
  const unitRow = resolveUnitOfMeasureFromBody(mat);
  return unitRow ? unitDenormalizedFirestoreFields(unitRow) : {};
}

/** Solo datos ya guardados en la orden (enviados por el front al crear/editar). */
function productionOrderMovementFields(
  order: Record<string, unknown>,
  warehouse: "source" | "destination"
): { warehouseName: string; locationId: string; locationName: string } {
  const locationId = normalizeTextForFirestore(order.locationId);
  const locationName = normalizeTextForFirestore(order.locationName);
  const sourceWarehouseName = normalizeTextForFirestore(order.sourceWarehouseName);
  const destinationWarehouseName = normalizeTextForFirestore(order.destinationWarehouseName);
  const warehouseName = warehouse === "source" ? sourceWarehouseName : destinationWarehouseName;

  if (!locationId) throw new Error("validation_error:La orden no tiene sede (locationId)");
  if (!locationName) throw new Error("validation_error:La orden no tiene nombre de sede (locationName)");
  if (!warehouseName) {
    throw new Error(
      warehouse === "source"
        ? "validation_error:La orden no tiene almacén origen (sourceWarehouseName)"
        : "validation_error:La orden no tiene almacén destino (destinationWarehouseName)"
    );
  }

  return { warehouseName, locationId, locationName };
}

type StockEntryLine = {
  productId: string;
  productName: string;
  quantity: number;
  unitFirestore: Record<string, string>;
};

function stockLevelDocId(productId: string, warehouseId: string): string {
  return `${productId}_${warehouseId}`;
}

function stockEntryTargets(
  db: FirebaseFirestore.Firestore,
  lines: StockEntryLine[],
  warehouseId: string
): { line: StockEntryLine; ref: FirebaseFirestore.DocumentReference }[] {
  return lines.map((line) => ({
    line,
    ref: db.collection("stock-levels").doc(stockLevelDocId(line.productId, warehouseId)),
  }));
}

/** Escribe stock tras lecturas previas en la misma transacción (reads-before-writes). */
function writeStockEntryLines(
  tx: FirebaseFirestore.Transaction,
  targets: { line: StockEntryLine; ref: FirebaseFirestore.DocumentReference }[],
  snaps: FirebaseFirestore.DocumentSnapshot[],
  warehouseId: string,
  warehouseName: string,
  location: { locationId: string; locationName: string },
  companyId: string,
  accountId: string,
  lastMovementDate: string
): void {
  for (let i = 0; i < targets.length; i++) {
    const { line, ref } = targets[i]!;
    const snap = snaps[i]!;
    const currentQty = snap.exists ? Number(snap.data()?.quantity) || 0 : 0;
    const newQty = currentQty + line.quantity;

    if (snap.exists) {
      tx.update(ref, {
        quantity: newQty,
        lastMovementDate,
      });
    } else {
      tx.set(ref, {
        productId: line.productId,
        productName: line.productName,
        warehouseId,
        warehouseName,
        quantity: newQty,
        ...line.unitFirestore,
        lastMovementDate,
        locationId: location.locationId,
        locationName: location.locationName,
        companyId,
        accountId,
      });
    }
  }
}

function orderMovementContext(
  orderId: string,
  uid: string,
  accountId: string,
  companyId: string,
  location: { locationId: string; locationName: string }
): Record<string, unknown> {
  return {
    referenceType: "production-order",
    referenceId: orderId,
    date: movementDateIso(),
    locationId: location.locationId,
    locationName: location.locationName,
    companyId,
    accountId,
    createAt: new Date(),
    createBy: uid,
  };
}

async function nextInventoryMovementCodes(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  count: number
): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(await generateSequenceCode(db, "web", accountId, "inventory-movement", "", companyId));
  }
  return codes;
}

function httpStatus(msg: string): number {
  if (msg.includes("unauthenticated")) return 401;
  if (msg.includes("forbidden")) return 403;
  if (msg.includes("not_found")) return 404;
  if (msg.includes("duplicate_code") || msg.includes("insufficient_stock") || msg.includes("invalid_transition") || msg.includes("circular_reference")) return 409;
  if (msg.includes("validation_error") || msg.includes("real_quantity_required") || msg.includes("recipe_not_active") || msg.includes("recipe_incomplete")) return 412;
  if (msg.includes("product_type_change_blocked") || msg.includes("product_not_found_in_catalog")) return 422;
  return 500;
}

async function requireCompanyScope(req: any): Promise<{ uid: string; accountId: string; companyId: string }> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const companyId = String(req.query?.companyId ?? req.body?.companyId ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  const db = getWebFirestore();
  const cuSnap = await db.collection("company-users").doc(`${companyId}_${uid}`).get();
  if (!cuSnap.exists) throw new Error("forbidden");
  const cu = cuSnap.data() as Record<string, unknown> | undefined;
  if (String(cu?.status ?? "").trim() === "inactive") throw new Error("forbidden");
  const accountId = String(cu?.accountId ?? "").trim();
  if (!accountId) throw new Error("forbidden");
  return { uid, accountId, companyId };
}

// ─── Response Transformers ────────────────────────────────────────────────────

function toRecipeRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    code: d.code ?? "",
    name: d.name ?? "",
    description: d.description ?? "",
    status: d.status ?? "inactive",
    version: d.version ?? 1,
    previousVersionId: d.previousVersionId ?? null,
    baseQuantity: d.baseQuantity ?? 0,
    baseUnitOfMeasureCode: d.baseUnitOfMeasureCode ?? "unit",
    baseUnitOfMeasureName: d.baseUnitOfMeasureName ?? "",
    baseUnitOfMeasureAbbreviation: d.baseUnitOfMeasureAbbreviation ?? "",
    companyId: d.companyId ?? "",
    accountId: d.accountId ?? "",
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

function toRecipeMaterialRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    productId: d.productId ?? "",
    productName: d.productName ?? "",
    productCode: d.productCode ?? "",
    quantity: d.quantity ?? 0,
    ...unitFieldsForApiResponse(d),
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

function toRecipeResultRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    type: d.type ?? "finished_good",
    productId: d.productId ?? "",
    productName: d.productName ?? "",
    productCode: d.productCode ?? "",
    description: d.description ?? "",
    quantity: d.quantity ?? 0,
    ...unitFieldsForApiResponse(d),
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

function toProductionOrderRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    code: d.code ?? "",
    status: d.status ?? "borrador",
    priority: d.priority ?? "media",
    recipeId: d.recipeId ?? "",
    recipeName: d.recipeName ?? "",
    recipeVersion: d.recipeVersion ?? 1,
    quantityToProduce: d.quantityToProduce ?? 0,
    productionFactor: d.productionFactor ?? 1,
    realQuantityProduced: d.realQuantityProduced ?? null,
    finishedProductId: d.finishedProductId ?? "",
    finishedProductName: d.finishedProductName ?? "",
    sourceWarehouseId: d.sourceWarehouseId ?? "",
    sourceWarehouseName: d.sourceWarehouseName ?? "",
    destinationWarehouseId: d.destinationWarehouseId ?? "",
    destinationWarehouseName: d.destinationWarehouseName ?? "",
    plannedStartDate: d.plannedStartDate ?? "",
    plannedEndDate: d.plannedEndDate ?? "",
    actualStartDate: d.actualStartDate ?? null,
    actualEndDate: d.actualEndDate ?? null,
    yieldPercentage: d.yieldPercentage ?? null,
    wastePercentage: d.wastePercentage ?? null,
    materialCost: d.materialCost ?? null,
    totalCost: d.totalCost ?? null,
    unitCost: d.unitCost ?? null,
    currency: d.currency ?? "PEN",
    companyId: d.companyId ?? "",
    accountId: d.accountId ?? "",
    locationId: d.locationId ?? "",
    locationName: d.locationName ?? "",
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

function toOrderMaterialRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    productId: d.productId ?? "",
    productName: d.productName ?? "",
    productCode: d.productCode ?? "",
    requiredQuantity: d.requiredQuantity ?? 0,
    ...unitFieldsForApiResponse(d),
    unitCostAtCreation: d.unitCostAtCreation ?? null,
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
  };
}

function toOrderResultRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    type: d.type ?? "finished_good",
    productId: d.productId ?? "",
    productName: d.productName ?? "",
    productCode: d.productCode ?? "",
    description: d.description ?? "",
    plannedQuantity: d.plannedQuantity ?? 0,
    actualQuantity: d.actualQuantity ?? 0,
    ...unitFieldsForApiResponse(d),
    monetaryValue: d.monetaryValue ?? null,
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

function toProductionCostRecord(d: FirebaseFirestore.DocumentData, id: string): Record<string, unknown> {
  return {
    id,
    type: d.type ?? "direct_labor",
    concept: d.concept ?? "",
    amount: d.amount ?? 0,
    hours: d.hours ?? null,
    hourlyRate: d.hourlyRate ?? null,
    allocationMethod: d.allocationMethod ?? null,
    percentage: d.percentage ?? null,
    fixedAmount: d.fixedAmount ?? null,
    totalAmountForProration: d.totalAmountForProration ?? null,
    createAt: d.createAt ?? null,
    createBy: d.createBy ?? "",
    updateAt: d.updateAt ?? null,
    updateBy: d.updateBy ?? "",
  };
}

// ─── Recipe CRUD ──────────────────────────────────────────────────────────────

// GET /production/recipes
router.get("/recipes", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const statusFilter = normalizeText(req.query.status);
    const snap = await db.collection("recipes")
      .where("companyId", "==", companyId)
      .get();
    let items = snap.docs.map((d) => toRecipeRecord(d.data(), d.id));
    if (statusFilter) {
      items = items.filter((r) => r.status === statusFilter);
    }
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /recipes error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// GET /production/recipes/:id
router.get("/recipes/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("recipes").doc(id).get();
    if (!snap.exists) return res.status(200).json(null);
    const d = snap.data()!;
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    res.status(200).json(toRecipeRecord(d, snap.id));
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /recipes/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/recipes
router.post("/recipes", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};

    const code = normalizeTextForFirestore(body.code);
    const name = normalizeTextForFirestore(body.name);

    // Validate required fields
    if (!code) return res.status(400).json({ error: "validation_error", message: "code is required" });
    if (!name) return res.status(400).json({ error: "validation_error", message: "name is required" });
    if (name.length > 100) return res.status(400).json({ error: "validation_error", message: "name max 100 characters" });

    // Validate code uniqueness
    const existingSnap = await db.collection("recipes")
      .where("companyId", "==", companyId)
      .where("code", "==", code)
      .get();
    if (!existingSnap.empty) {
      return res.status(409).json({ error: "duplicate_code", message: `El código "${code}" ya está en uso` });
    }

    const doc: Record<string, unknown> = {
      code,
      name,
      description: normalizeTextForFirestore(body.description),
      status: "inactive",
      version: 1,
      previousVersionId: null,
      baseQuantity: Number(body.baseQuantity) || 1,
      baseUnitOfMeasureCode: normalizeTextForFirestore(body.baseUnitOfMeasureCode),
      baseUnitOfMeasureName: normalizeTextForFirestore(body.baseUnitOfMeasureName),
      baseUnitOfMeasureAbbreviation: normalizeTextForFirestore(body.baseUnitOfMeasureAbbreviation),
      companyId,
      accountId,
      createAt: new Date(),
      createBy: uid,
      updateAt: new Date(),
      updateBy: uid,
    };

    const ref = await db.collection("recipes").add(doc);
    logWebApi("recipe:created", { id: ref.id, code, name });

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "recipe",
      action: "create",
      recordId: ref.id,
      fields: { code, name, status: "inactive" },
    }).catch(() => {});

    trackEntityChange(db, {
      accountId, companyId,
      collectionName: "recipes",
      action: "create",
    }).catch(() => {});

    res.status(201).json({ ok: true, id: ref.id });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /recipes error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/recipes/:id
router.put("/recipes/:id", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    const snap = await db.collection("recipes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    // Check if recipe has orders in_proceso — version if so
    const ordersSnap = await db.collection("production-orders")
      .where("companyId", "==", companyId)
      .where("recipeId", "==", id)
      .where("status", "==", "en_proceso")
      .get();

    const newCode = normalizeTextForFirestore(body.code ?? existing.code);
    const newName = normalizeTextForFirestore(body.name ?? existing.name);

    if (!ordersSnap.empty) {
      // Version the recipe: create a new doc with incremented version
      const newVersion = (existing.version ?? 1) + 1;
      const newDoc: Record<string, unknown> = {
        code: newCode,
        name: newName,
        description: normalizeTextForFirestore(body.description ?? existing.description),
        status: existing.status ?? "inactive",
        version: newVersion,
        previousVersionId: id,
        baseQuantity: Number(body.baseQuantity ?? existing.baseQuantity) || 1,
        baseUnitOfMeasureCode: normalizeTextForFirestore(body.baseUnitOfMeasureCode ?? existing.baseUnitOfMeasureCode),
        baseUnitOfMeasureName: normalizeTextForFirestore(body.baseUnitOfMeasureName ?? existing.baseUnitOfMeasureName),
        baseUnitOfMeasureAbbreviation: normalizeTextForFirestore(body.baseUnitOfMeasureAbbreviation ?? existing.baseUnitOfMeasureAbbreviation),
        companyId,
        accountId,
        createAt: new Date(),
        createBy: uid,
        updateAt: new Date(),
        updateBy: uid,
      };
      const newRef = await db.collection("recipes").add(newDoc);

      // Copy subcollections from old version
      const materialsSnap = await db.collection("recipes").doc(id).collection("recipe-materials").get();
      for (const matDoc of materialsSnap.docs) {
        await db.collection("recipes").doc(newRef.id).collection("recipe-materials").doc(matDoc.id).set(matDoc.data());
      }
      const resultsSnap = await db.collection("recipes").doc(id).collection("recipe-results").get();
      for (const resDoc of resultsSnap.docs) {
        await db.collection("recipes").doc(newRef.id).collection("recipe-results").doc(resDoc.id).set(resDoc.data());
      }

      logWebApi("recipe:versioned", { oldId: id, newId: newRef.id, version: newVersion });

      updateEntitySearchIndex(db, {
        accountId, companyId,
        entityId: "recipe",
        action: "create",
        recordId: newRef.id,
        fields: { code: newCode, name: newName, status: existing.status ?? "inactive" },
      }).catch(() => {});

      return res.status(200).json({ ok: true, id: newRef.id, versioned: true });
    }

    // No active orders — update in place
    const updates: Record<string, unknown> = {};
    if (body.code !== undefined) updates.code = newCode;
    if (body.name !== undefined) updates.name = newName;
    if (body.description !== undefined) updates.description = normalizeTextForFirestore(body.description);
    if (body.status !== undefined) updates.status = normalizeText(body.status) ?? existing.status;
    if (body.baseQuantity !== undefined) updates.baseQuantity = Number(body.baseQuantity) || 1;
    if (body.baseUnitOfMeasureCode !== undefined) {
      updates.baseUnitOfMeasureCode = normalizeTextForFirestore(body.baseUnitOfMeasureCode);
      if (body.baseUnitOfMeasureName !== undefined) updates.baseUnitOfMeasureName = normalizeTextForFirestore(body.baseUnitOfMeasureName);
      if (body.baseUnitOfMeasureAbbreviation !== undefined) updates.baseUnitOfMeasureAbbreviation = normalizeTextForFirestore(body.baseUnitOfMeasureAbbreviation);
    }
    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("recipes").doc(id).update(updates);

    logWebApi("recipe:updated", { id });

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "recipe",
      action: "update",
      recordId: id,
      fields: { code: newCode, name: newName, status: updates.status ?? existing.status },
    }).catch(() => {});

    trackEntityChange(db, {
      accountId, companyId,
      collectionName: "recipes",
      action: "update",
      document: { ...existing, ...updates },
      previousDocument: existing,
    }).catch(() => {});

    res.status(200).json({ ok: true, id });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /recipes/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// DELETE /production/recipes/:id
router.delete("/recipes/:id", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("recipes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    // Check if recipe has any orders
    const ordersSnap = await db.collection("production-orders")
      .where("companyId", "==", companyId)
      .where("recipeId", "==", id)
      .limit(1)
      .get();
    if (!ordersSnap.empty) {
      return res.status(409).json({ error: "validation_error", message: "No se puede eliminar una receta con órdenes asociadas" });
    }

    // Delete subcollections
    const materialsSnap = await db.collection("recipes").doc(id).collection("recipe-materials").get();
    const batch = db.batch();
    materialsSnap.docs.forEach((d) => batch.delete(d.ref));
    const resultsSnap = await db.collection("recipes").doc(id).collection("recipe-results").get();
    resultsSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(db.collection("recipes").doc(id));
    await batch.commit();

    logWebApi("recipe:deleted", { id });

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "recipe",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});

    trackEntityChange(db, {
      accountId, companyId,
      collectionName: "recipes",
      action: "delete",
      previousDocument: existing,
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] DELETE /recipes/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/recipes/:id/activate
router.post("/recipes/:id/activate", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("recipes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    // Validate at least 1 material
    const materialsSnap = await db.collection("recipes").doc(id).collection("recipe-materials").limit(1).get();
    if (materialsSnap.empty) {
      return res.status(412).json({ error: "recipe_incomplete", message: "La receta debe tener al menos un material" });
    }

    // Validate at least 1 finished_good result
    const resultsSnap = await db.collection("recipes").doc(id).collection("recipe-results")
      .where("type", "==", "finished_good")
      .limit(1)
      .get();
    if (resultsSnap.empty) {
      return res.status(412).json({ error: "recipe_incomplete", message: "La receta debe tener al menos un producto terminado" });
    }

    await db.collection("recipes").doc(id).update({
      status: "active",
      updateAt: new Date(),
      updateBy: uid,
    });

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /recipes/:id/activate error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/recipes/:id/deactivate
router.post("/recipes/:id/deactivate", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("recipes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    await db.collection("recipes").doc(id).update({
      status: "inactive",
      updateAt: new Date(),
      updateBy: uid,
    });

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /recipes/:id/deactivate error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Recipe Materials Subcollection ───────────────────────────────────────────

async function verifyRecipeParent(db: FirebaseFirestore.Firestore, recipeId: string, companyId: string): Promise<Record<string, unknown> | null> {
  const snap = await db.collection("recipes").doc(recipeId).get();
  if (!snap.exists) return null;
  const d = snap.data()!;
  if (String(d.companyId ?? "").trim() !== companyId) return null;
  return { ...d, id: snap.id };
}

// GET /production/recipes/:id/materials
router.get("/recipes/:id/materials", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const snap = await db.collection("recipes").doc(id).collection("recipe-materials").get();
    const items = snap.docs.map((d) => toRecipeMaterialRecord(d.data(), d.id));
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /recipes/:id/materials error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/recipes/:id/materials
router.post("/recipes/:id/materials", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const { id } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const productId = normalizeTextForFirestore(body.productId);
    if (!productId) return res.status(400).json({ error: "validation_error", message: "productId is required" });

    // Validate product exists and is correct type
    const productSnap = await db.collection("products").doc(productId).get();
    if (!productSnap.exists) {
      return res.status(422).json({ error: "product_not_found_in_catalog", message: `Producto ${productId} no encontrado` });
    }
    const product = productSnap.data()!;
    const productType = String(product.type ?? "").trim();
    if (!["raw_material", "semi_finished", "supply"].includes(productType)) {
      return res.status(422).json({ error: "validation_error", message: "El producto debe ser de tipo Materia prima, Semielaborado o Insumo" });
    }

    // Check circular reference: product cannot be the finished_good of this recipe
    const finishedResultsSnap = await db.collection("recipes").doc(id).collection("recipe-results")
      .where("type", "==", "finished_good")
      .where("productId", "==", productId)
      .limit(1)
      .get();
    if (!finishedResultsSnap.empty) {
      return res.status(409).json({ error: "circular_reference", message: "El producto ya es el producto terminado de esta receta" });
    }

    // Check max 50 materials
    const countSnap = await db.collection("recipes").doc(id).collection("recipe-materials").get();
    if (countSnap.size >= 50) {
      return res.status(400).json({ error: "validation_error", message: "Máximo 50 materiales por receta" });
    }

    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({ error: "validation_error", message: "unitOfMeasureCode is required" });
    }

    const qty = Number(body.quantity) || 0;
    if (qty <= 0) {
      return res.status(400).json({ error: "validation_error", message: "quantity must be greater than 0" });
    }

    const doc: Record<string, unknown> = {
      productId,
      productName: normalizeTextForFirestore(body.productName ?? product.name),
      productCode: normalizeTextForFirestore(body.productCode ?? product.code),
      quantity: qty,
      ...unitDenormalizedFirestoreFields(unitRow),
      createAt: new Date(),
      createBy: uid,
    };

    const ref = await db.collection("recipes").doc(id).collection("recipe-materials").add(doc);
    res.status(201).json({ ok: true, id: ref.id });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /recipes/:id/materials error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/recipes/:id/materials/:materialId
router.put("/recipes/:id/materials/:materialId", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const { id, materialId } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const matSnap = await db.collection("recipes").doc(id).collection("recipe-materials").doc(materialId).get();
    if (!matSnap.exists) return res.status(404).json({ error: "not_found" });

    const updates: Record<string, unknown> = {};
    if (body.productId !== undefined) {
      const productId = normalizeTextForFirestore(body.productId);
      const productSnap = await db.collection("products").doc(productId).get();
      if (!productSnap.exists) {
        return res.status(422).json({ error: "product_not_found_in_catalog" });
      }
      const product = productSnap.data()!;
      updates.productId = productId;
      updates.productName = normalizeTextForFirestore(body.productName ?? product.name);
      updates.productCode = normalizeTextForFirestore(body.productCode ?? product.code);
    }
    if (body.quantity !== undefined) {
      const qty = Number(body.quantity) || 0;
      if (qty <= 0) return res.status(400).json({ error: "validation_error", message: "quantity must be greater than 0" });
      updates.quantity = qty;
    }
    if (body.unitOfMeasureCode !== undefined) {
      const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
      if (!unitRow) return res.status(400).json({ error: "validation_error", message: "unitOfMeasureCode is required" });
      Object.assign(updates, unitDenormalizedFirestoreFields(unitRow));
    }
    if (body.productName !== undefined) updates.productName = normalizeTextForFirestore(body.productName);
    if (body.productCode !== undefined) updates.productCode = normalizeTextForFirestore(body.productCode);
    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("recipes").doc(id).collection("recipe-materials").doc(materialId).update(updates);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /recipes/:id/materials/:materialId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// DELETE /production/recipes/:id/materials/:materialId
router.delete("/recipes/:id/materials/:materialId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id, materialId } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    await db.collection("recipes").doc(id).collection("recipe-materials").doc(materialId).delete();
    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] DELETE /recipes/:id/materials/:materialId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Recipe Results Subcollection ─────────────────────────────────────────────

// GET /production/recipes/:id/results
router.get("/recipes/:id/results", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const snap = await db.collection("recipes").doc(id).collection("recipe-results").get();
    const items = snap.docs.map((d) => toRecipeResultRecord(d.data(), d.id));
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /recipes/:id/results error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/recipes/:id/results
router.post("/recipes/:id/results", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const { id } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const resultType = normalizeText(body.type) ?? "finished_good";
    if (!["finished_good", "by_product", "waste"].includes(resultType)) {
      return res.status(400).json({ error: "validation_error", message: "type must be finished_good, by_product, or waste" });
    }

    // Check max 20 results
    const countSnap = await db.collection("recipes").doc(id).collection("recipe-results").get();
    if (countSnap.size >= 20) {
      return res.status(400).json({ error: "validation_error", message: "Máximo 20 resultados por receta" });
    }

    let productId = normalizeTextForFirestore(body.productId);
    let productName = normalizeTextForFirestore(body.productName);
    let productCode = normalizeTextForFirestore(body.productCode);

    if (resultType === "finished_good" || resultType === "by_product") {
      if (!productId) return res.status(400).json({ error: "validation_error", message: "productId is required for finished_good/by_product" });
      const productSnap = await db.collection("products").doc(productId).get();
      if (!productSnap.exists) {
        return res.status(422).json({ error: "product_not_found_in_catalog", message: `Producto ${productId} no encontrado` });
      }
      const product = productSnap.data()!;
      const pType = String(product.type ?? "").trim();
      if (!["finished_good", "semi_finished"].includes(pType)) {
        return res.status(422).json({ error: "validation_error", message: "El producto debe ser de tipo Producto terminado o Semielaborado" });
      }
      productName = normalizeTextForFirestore(body.productName ?? product.name);
      productCode = normalizeTextForFirestore(body.productCode ?? product.code);

      // Check circular reference: product cannot also be a material in this recipe
      const materialSnap = await db.collection("recipes").doc(id).collection("recipe-materials")
        .where("productId", "==", productId)
        .limit(1)
        .get();
      if (!materialSnap.empty) {
        return res.status(409).json({ error: "circular_reference", message: "El producto no puede ser material y producto terminado en la misma receta" });
      }
    }

    const description = resultType === "waste" ? normalizeTextForFirestore(body.description) : "";

    const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
    if (!unitRow) {
      return res.status(400).json({ error: "validation_error", message: "unitOfMeasureCode is required" });
    }

    const qty = Number(body.quantity) || 0;
    if (qty <= 0 && resultType !== "waste") {
      return res.status(400).json({ error: "validation_error", message: "quantity must be greater than 0" });
    }

    const doc: Record<string, unknown> = {
      type: resultType,
      productId,
      productName,
      productCode,
      description,
      quantity: qty,
      ...unitDenormalizedFirestoreFields(unitRow),
      createAt: new Date(),
      createBy: uid,
    };

    const ref = await db.collection("recipes").doc(id).collection("recipe-results").add(doc);
    res.status(201).json({ ok: true, id: ref.id });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /recipes/:id/results error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/recipes/:id/results/:resultId
router.put("/recipes/:id/results/:resultId", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const { id, resultId } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    const resSnap = await db.collection("recipes").doc(id).collection("recipe-results").doc(resultId).get();
    if (!resSnap.exists) return res.status(404).json({ error: "not_found" });

    const updates: Record<string, unknown> = {};
    if (body.type !== undefined) {
      const t = normalizeText(body.type);
      if (!t || !["finished_good", "by_product", "waste"].includes(t)) {
        return res.status(400).json({ error: "validation_error", message: "type must be finished_good, by_product, or waste" });
      }
      updates.type = t;
    }
    if (body.productId !== undefined) {
      const pid = normalizeTextForFirestore(body.productId);
      const productSnap = await db.collection("products").doc(pid).get();
      if (!productSnap.exists) return res.status(422).json({ error: "product_not_found_in_catalog" });
      const product = productSnap.data()!;
      updates.productId = pid;
      updates.productName = normalizeTextForFirestore(body.productName ?? product.name);
      updates.productCode = normalizeTextForFirestore(body.productCode ?? product.code);
    }
    if (body.quantity !== undefined) updates.quantity = Number(body.quantity) || 0;
    if (body.description !== undefined) updates.description = normalizeTextForFirestore(body.description);
    if (body.unitOfMeasureCode !== undefined) {
      const unitRow = resolveUnitOfMeasureFromBody(body as Record<string, unknown>);
      if (!unitRow) return res.status(400).json({ error: "validation_error", message: "unitOfMeasureCode is required" });
      Object.assign(updates, unitDenormalizedFirestoreFields(unitRow));
    }
    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("recipes").doc(id).collection("recipe-results").doc(resultId).update(updates);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /recipes/:id/results/:resultId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// DELETE /production/recipes/:id/results/:resultId
router.delete("/recipes/:id/results/:resultId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id, resultId } = req.params;

    const parent = await verifyRecipeParent(db, id, companyId);
    if (!parent) return res.status(404).json({ error: "not_found" });

    await db.collection("recipes").doc(id).collection("recipe-results").doc(resultId).delete();
    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] DELETE /recipes/:id/results/:resultId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Production Orders CRUD ───────────────────────────────────────────────────

// GET /production/orders
router.get("/orders", async (req, res) => {
  try {
    const { companyId, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const statusFilter = normalizeText(req.query.status);
    const recipeIdFilter = normalizeText(req.query.recipeId);
    const dateFrom = normalizeText(req.query.dateFrom);
    const dateTo = normalizeText(req.query.dateTo);
    const productFilter = normalizeText(req.query.productId);

    const snap = await db.collection("production-orders")
      .where("companyId", "==", companyId)
      .get();

    let items = snap.docs.map((d) => toProductionOrderRecord(d.data(), d.id));

    if (statusFilter) items = items.filter((o) => o.status === statusFilter);
    if (recipeIdFilter) items = items.filter((o) => o.recipeId === recipeIdFilter);
    if (productFilter) items = items.filter((o) => o.finishedProductId === productFilter);
    if (dateFrom) items = items.filter((o) => String(o.plannedStartDate ?? "") >= dateFrom);
    if (dateTo) items = items.filter((o) => String(o.plannedStartDate ?? "") <= dateTo);

    items.sort((a, b) => {
      const da = a.createAt ? new Date(a.createAt as string).getTime() : 0;
      const db2 = b.createAt ? new Date(b.createAt as string).getTime() : 0;
      return db2 - da;
    });

    // Max 500 records
    items = items.slice(0, 500);

    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /orders error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// GET /production/orders/:id
router.get("/orders/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(200).json(null);
    const d = snap.data()!;
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    res.status(200).json(toProductionOrderRecord(d, snap.id));
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /orders/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// POST /production/orders
router.post("/orders", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};

    const recipeId = normalizeTextForFirestore(body.recipeId);
    if (!recipeId) return res.status(400).json({ error: "validation_error", message: "recipeId is required" });

    // Validate recipe exists and is active
    const recipeSnap = await db.collection("recipes").doc(recipeId).get();
    if (!recipeSnap.exists) return res.status(404).json({ error: "not_found", message: "Receta no encontrada" });
    const recipe = recipeSnap.data()!;
    if (String(recipe.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    if (recipe.status !== "active") return res.status(412).json({ error: "recipe_not_active", message: "La receta debe estar activa" });

    const qtyToProduce = Number(body.quantityToProduce) || 0;
    if (qtyToProduce <= 0) return res.status(400).json({ error: "validation_error", message: "quantityToProduce must be greater than 0" });

    const baseQty = Number(recipe.baseQuantity) || 1;
    const productionFactor = qtyToProduce / baseQty;

    const plannedStartDate = normalizeTextForFirestore(body.plannedStartDate);
    const plannedEndDate = normalizeTextForFirestore(body.plannedEndDate);
    if (!plannedStartDate || !plannedEndDate) {
      return res.status(400).json({ error: "validation_error", message: "plannedStartDate and plannedEndDate are required" });
    }
    if (plannedStartDate > plannedEndDate) {
      return res.status(400).json({ error: "validation_error", message: "plannedStartDate must be before or equal to plannedEndDate" });
    }

    const sourceWarehouseId = normalizeTextForFirestore(body.sourceWarehouseId);
    const destinationWarehouseId = normalizeTextForFirestore(body.destinationWarehouseId);
    const sourceWarehouseName = normalizeTextForFirestore(body.sourceWarehouseName);
    const destinationWarehouseName = normalizeTextForFirestore(body.destinationWarehouseName);
    const locationId = normalizeTextForFirestore(body.locationId);
    const locationName = normalizeTextForFirestore(body.locationName);
    if (!sourceWarehouseId) return res.status(400).json({ error: "validation_error", message: "sourceWarehouseId is required" });
    if (!destinationWarehouseId) return res.status(400).json({ error: "validation_error", message: "destinationWarehouseId is required" });
    if (!sourceWarehouseName) return res.status(400).json({ error: "validation_error", message: "sourceWarehouseName is required" });
    if (!destinationWarehouseName) return res.status(400).json({ error: "validation_error", message: "destinationWarehouseName is required" });
    if (!locationId) return res.status(400).json({ error: "validation_error", message: "locationId is required" });
    if (!locationName) return res.status(400).json({ error: "validation_error", message: "locationName is required" });

    // Use provided code when present (manual override/standard DpCodeInput flow), otherwise generate.
    const requestedCode = normalizeText(body.code) ?? "";
    const code = await generateSequenceCode(db, "web", accountId, "production-order", requestedCode, companyId);

    // Find finished product from recipe-results
    const recipeResultsSnap = await db.collection("recipes").doc(recipeId).collection("recipe-results")
      .where("type", "==", "finished_good")
      .limit(1)
      .get();
    let finishedProductId = "";
    let finishedProductName = "";
    if (!recipeResultsSnap.empty) {
      const fg = recipeResultsSnap.docs[0].data();
      finishedProductId = String(fg.productId ?? "");
      finishedProductName = String(fg.productName ?? "");
    }

    // Create order document
    const orderDoc: Record<string, unknown> = {
      code,
      status: "borrador",
      priority: normalizeText(body.priority) ?? "media",
      recipeId,
      recipeName: normalizeTextForFirestore(recipe.name),
      recipeVersion: recipe.version ?? 1,
      quantityToProduce: qtyToProduce,
      productionFactor,
      realQuantityProduced: null,
      finishedProductId,
      finishedProductName,
      sourceWarehouseId,
      sourceWarehouseName,
      destinationWarehouseId,
      destinationWarehouseName,
      plannedStartDate,
      plannedEndDate,
      actualStartDate: null,
      actualEndDate: null,
      yieldPercentage: null,
      wastePercentage: null,
      materialCost: null,
      totalCost: null,
      unitCost: null,
      currency: normalizeText(body.currency) ?? "PEN",
      companyId,
      accountId,
      locationId,
      locationName,
      createAt: new Date(),
      createBy: uid,
      updateAt: new Date(),
      updateBy: uid,
    };

    const orderRef = await db.collection("production-orders").add(orderDoc);
    const orderId = orderRef.id;

    // Copy recipe-materials to order-materials with calculated quantities
    const recipeMaterialsSnap = await db.collection("recipes").doc(recipeId).collection("recipe-materials").get();
    for (const matDoc of recipeMaterialsSnap.docs) {
      const mat = matDoc.data();
      const requiredQty = Math.round((Number(mat.quantity) * productionFactor) * 10000) / 10000;
      await db.collection("production-orders").doc(orderId).collection("order-materials").add({
        productId: mat.productId ?? "",
        productName: mat.productName ?? "",
        productCode: mat.productCode ?? "",
        requiredQuantity: requiredQty,
        unitOfMeasureId: mat.unitOfMeasureId ?? "",
        unitOfMeasureCode: mat.unitOfMeasureCode ?? "",
        unitOfMeasureName: mat.unitOfMeasureName ?? "",
        unitOfMeasureAbbreviation: mat.unitOfMeasureAbbreviation ?? "",
        unitOfMeasureSunatCode: mat.unitOfMeasureSunatCode ?? "",
        unitOfMeasureSunatName: mat.unitOfMeasureSunatName ?? "",
        unitCostAtCreation: null,
        createAt: new Date(),
        createBy: uid,
      });
    }

    // Copy recipe-results to order-results with calculated quantities
    const recipeResultsSnap2 = await db.collection("recipes").doc(recipeId).collection("recipe-results").get();
    for (const resDoc of recipeResultsSnap2.docs) {
      const result = resDoc.data();
      const plannedQty = Math.round((Number(result.quantity) * productionFactor) * 10000) / 10000;
      await db.collection("production-orders").doc(orderId).collection("order-results").add({
        type: result.type ?? "finished_good",
        productId: result.productId ?? "",
        productName: result.productName ?? "",
        productCode: result.productCode ?? "",
        description: result.description ?? "",
        plannedQuantity: plannedQty,
        actualQuantity: 0,
        unitOfMeasureId: result.unitOfMeasureId ?? "",
        unitOfMeasureCode: result.unitOfMeasureCode ?? "",
        unitOfMeasureName: result.unitOfMeasureName ?? "",
        unitOfMeasureAbbreviation: result.unitOfMeasureAbbreviation ?? "",
        unitOfMeasureSunatCode: result.unitOfMeasureSunatCode ?? "",
        unitOfMeasureSunatName: result.unitOfMeasureSunatName ?? "",
        monetaryValue: null,
        createAt: new Date(),
        createBy: uid,
      });
    }

    logWebApi("order:created", { id: orderId, code, recipeId });

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "production-order",
      action: "create",
      recordId: orderId,
      fields: { code, finishedProductName, status: "borrador" },
    }).catch(() => {});

    trackEntityChange(db, {
      accountId, companyId,
      collectionName: "production-orders",
      action: "create",
    }).catch(() => {});

    res.status(201).json({ ok: true, id: orderId, code });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /orders error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/orders/:id
router.put("/orders/:id", async (req, res) => {
  try {
    const { companyId, accountId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    // Only editable in borrador/planificada
    const status = String(existing.status ?? "").trim();
    if (status !== "borrador" && status !== "planificada") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede editar órdenes en borrador o planificada" });
    }

    const updates: Record<string, unknown> = {};
    if (body.quantityToProduce !== undefined) updates.quantityToProduce = Number(body.quantityToProduce) || 0;
    if (body.priority !== undefined) updates.priority = normalizeText(body.priority) ?? existing.priority;
    if (body.sourceWarehouseId !== undefined) updates.sourceWarehouseId = normalizeTextForFirestore(body.sourceWarehouseId);
    if (body.sourceWarehouseName !== undefined) updates.sourceWarehouseName = normalizeTextForFirestore(body.sourceWarehouseName);
    if (body.destinationWarehouseId !== undefined) updates.destinationWarehouseId = normalizeTextForFirestore(body.destinationWarehouseId);
    if (body.destinationWarehouseName !== undefined) updates.destinationWarehouseName = normalizeTextForFirestore(body.destinationWarehouseName);

    // Validate dates
    const startDate = normalizeText(body.plannedStartDate) ?? existing.plannedStartDate;
    const endDate = normalizeText(body.plannedEndDate) ?? existing.plannedEndDate;
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: "validation_error", message: "plannedStartDate must be before or equal to plannedEndDate" });
    }
    if (body.plannedStartDate !== undefined) updates.plannedStartDate = normalizeTextForFirestore(body.plannedStartDate);
    if (body.plannedEndDate !== undefined) updates.plannedEndDate = normalizeTextForFirestore(body.plannedEndDate);
    if (body.locationId !== undefined) updates.locationId = normalizeTextForFirestore(body.locationId);
    if (body.locationName !== undefined) updates.locationName = normalizeTextForFirestore(body.locationName);

    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("production-orders").doc(id).update(updates);

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "production-order",
      action: "update",
      recordId: id,
      fields: {
        code: String(existing.code ?? ""),
        finishedProductName: String(existing.finishedProductName ?? ""),
        status: String(existing.status ?? ""),
      },
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /orders/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// DELETE /production/orders/:id
router.delete("/orders/:id", async (req, res) => {
  try {
    const { companyId, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const status = String(existing.status ?? "").trim();
    if (status !== "borrador") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede eliminar órdenes en borrador" });
    }

    // Delete subcollections and main document
    const batch = db.batch();

    const materialsSnap = await db.collection("production-orders").doc(id).collection("order-materials").get();
    materialsSnap.docs.forEach((d) => batch.delete(d.ref));

    const resultsSnap = await db.collection("production-orders").doc(id).collection("order-results").get();
    resultsSnap.docs.forEach((d) => batch.delete(d.ref));

    const costsSnap = await db.collection("production-orders").doc(id).collection("costs").get();
    costsSnap.docs.forEach((d) => batch.delete(d.ref));

    batch.delete(db.collection("production-orders").doc(id));
    await batch.commit();

    updateEntitySearchIndex(db, {
      accountId, companyId,
      entityId: "production-order",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});

    trackEntityChange(db, {
      accountId, companyId,
      collectionName: "production-orders",
      action: "delete",
      previousDocument: existing,
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] DELETE /orders/:id error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Order State Transition ───────────────────────────────────────────────────

function getValidTransitions(currentStatus: string): string[] {
  const map: Record<string, string[]> = {
    borrador: ["planificada"],
    planificada: ["en_proceso", "cancelada"],
    en_proceso: ["completada", "cancelada"],
  };
  return map[currentStatus] ?? [];
}

// POST /production/orders/:id/transition
router.post("/orders/:id/transition", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;
    const body = req.body ?? {};
    const targetStatus = normalizeText(body.targetStatus);
    if (!targetStatus) return res.status(400).json({ error: "validation_error", message: "targetStatus is required" });

    const orderRef = db.collection("production-orders").doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const existing = snap.data()!;
    if (String(existing.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const currentStatus = String(existing.status ?? "").trim();
    const validTransitions = getValidTransitions(currentStatus);
    if (!validTransitions.includes(targetStatus)) {
      return res.status(409).json({ error: "invalid_transition", message: `No se puede cambiar de ${currentStatus} a ${targetStatus}` });
    }

    // ── borrador → planificada ──
    if (currentStatus === "borrador" && targetStatus === "planificada") {
      // Validate recipe active
      const recipeId = String(existing.recipeId ?? "").trim();
      const recipeSnap = await db.collection("recipes").doc(recipeId).get();
      if (!recipeSnap.exists) return res.status(404).json({ error: "not_found", message: "Receta no encontrada" });
      const recipe = recipeSnap.data()!;
      if (String(recipe.status ?? "").trim() !== "active") {
        return res.status(412).json({ error: "recipe_not_active", message: "La receta asociada no está activa" });
      }

      // Validate dates
      const sDate = String(existing.plannedStartDate ?? "").trim();
      const eDate = String(existing.plannedEndDate ?? "").trim();
      if (sDate && eDate && sDate > eDate) {
        return res.status(400).json({ error: "validation_error", message: "plannedStartDate debe ser anterior a plannedEndDate" });
      }

      await orderRef.update({
        status: "planificada",
        updateAt: new Date(),
        updateBy: uid,
      });

      updateEntitySearchIndex(db, {
        accountId, companyId,
        entityId: "production-order",
        action: "update",
        recordId: id,
        fields: { code: existing.code ?? "", finishedProductName: existing.finishedProductName ?? "", status: "planificada" },
      }).catch(() => {});

      return res.status(200).json({ ok: true, status: "planificada" });
    }

    // ── planificada → en_proceso ──
    if (currentStatus === "planificada" && targetStatus === "en_proceso") {
      // Read order-materials subcollection
      const materialsSnap = await db.collection("production-orders").doc(id).collection("order-materials").get();
      if (materialsSnap.empty) {
        return res.status(412).json({ error: "validation_error", message: "La orden no tiene materiales" });
      }

      const materials = materialsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
      const sourceWarehouseId = String(existing.sourceWarehouseId ?? "").trim();

      // Verify stock levels and collect insufficient stock
      const insufficientStock: { productName: string; required: number; available: number }[] = [];
      const materialMovements: {
        productId: string;
        quantity: number;
        productName: string;
        unitFirestore: Record<string, string>;
      }[] = [];

      for (const mat of materials) {
        const productId = String(mat.productId ?? "").trim();
        const requiredQty = Number(mat.requiredQuantity) || 0;

        const stockKey = `${productId}_${sourceWarehouseId}`;
        const stockSnap = await db.collection("stock-levels").doc(stockKey).get();
        const availableQty = stockSnap.exists ? Number(stockSnap.data()?.quantity ?? 0) : 0;

        if (availableQty < requiredQty) {
          insufficientStock.push({
            productName: String(mat.productName ?? ""),
            required: requiredQty,
            available: availableQty,
          });
        }

        materialMovements.push({
          productId,
          quantity: requiredQty,
          productName: String(mat.productName ?? ""),
          unitFirestore: unitFirestoreFromMaterial(mat),
        });
      }

      if (insufficientStock.length > 0) {
        return res.status(409).json({
          error: "insufficient_stock",
          message: "Stock insuficiente para iniciar la producción",
          details: insufficientStock,
        });
      }

      const exitMovementCodes = await nextInventoryMovementCodes(
        db,
        accountId,
        companyId,
        materialMovements.length
      );
      const sourceMovementFields = productionOrderMovementFields(existing, "source");
      const movementCtx = orderMovementContext(id, uid, accountId, companyId, sourceMovementFields);

      // Execute atomic transaction for exit movements
      let exitCodeIndex = 0;
      await db.runTransaction(async (tx) => {
        for (const mov of materialMovements) {
          const stockKey = `${mov.productId}_${sourceWarehouseId}`;
          const stockRef = db.collection("stock-levels").doc(stockKey);
          const stockDoc = await tx.get(stockRef);
          const currentQty = stockDoc.exists ? Number(stockDoc.data()?.quantity ?? 0) : 0;
          if (currentQty < mov.quantity) {
            throw new Error(`insufficient_stock:${mov.productName}`);
          }
          tx.update(stockRef, { quantity: FieldValue.increment(-mov.quantity) });

          const movementRef = db.collection("inventory-movements").doc();
          tx.set(movementRef, {
            code: exitMovementCodes[exitCodeIndex++] ?? "",
            type: "exit",
            warehouseId: sourceWarehouseId,
            warehouseName: sourceMovementFields.warehouseName,
            productId: mov.productId,
            productName: mov.productName,
            quantity: mov.quantity,
            ...mov.unitFirestore,
            ...movementCtx,
          });
        }

        tx.update(orderRef, {
          status: "en_proceso",
          actualStartDate: new Date().toISOString().split("T")[0],
          updateAt: new Date(),
          updateBy: uid,
        });
      });

      updateEntitySearchIndex(db, {
        accountId, companyId,
        entityId: "production-order",
        action: "update",
        recordId: id,
        fields: { code: existing.code ?? "", finishedProductName: existing.finishedProductName ?? "", status: "en_proceso" },
      }).catch(() => {});

      trackMetric(db, {
        accountId, companyId,
        metricKey: "production-orders-in-progress-count",
        delta: 1,
      }).catch(() => {});

      trackMetric(db, {
        accountId, companyId,
        metricKey: "inventory-movements-count",
        delta: materialMovements.length,
      }).catch(() => {});

      return res.status(200).json({ ok: true, status: "en_proceso" });
    }

    // ── en_proceso → completada ──
    if (currentStatus === "en_proceso" && targetStatus === "completada") {
      const realQty = Number(body.realQuantityProduced) || 0;
      if (realQty <= 0) {
        return res.status(412).json({ error: "real_quantity_required", message: "Se requiere cantidad real producida mayor a 0" });
      }

      // Read order-results subcollection
      const resultsSnap = await db.collection("production-orders").doc(id).collection("order-results").get();
      if (resultsSnap.empty) {
        return res.status(412).json({ error: "validation_error", message: "La orden no tiene resultados" });
      }

      const results = resultsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
      const destWarehouseId = String(existing.destinationWarehouseId ?? "").trim();

      // Calculate yield and waste
      const finishedGoodResult = results.find((r) => r.type === "finished_good");
      const plannedQty = finishedGoodResult ? Number(finishedGoodResult.plannedQuantity) || 0 : 0;
      const yieldPct = plannedQty > 0 ? Math.round((realQty / plannedQty) * 10000) / 100 : 0;

      // Calculate total waste
      const wasteResults = results.filter((r) => r.type === "waste");
      const totalWaste = wasteResults.reduce((sum, w) => sum + (Number(w.actualQuantity) || 0), 0);

      // Calculate total materials consumed from order-materials
      const orderMatSnap = await db.collection("production-orders").doc(id).collection("order-materials").get();
      let totalMaterialsConsumed = 0;
      const materialMovements: { productId: string; quantity: number; productName: string }[] = [];

      for (const matDoc of orderMatSnap.docs) {
        const mat = matDoc.data();
        const qty = Number(mat.requiredQuantity) || 0;
        totalMaterialsConsumed += qty;
        materialMovements.push({
          productId: String(mat.productId ?? ""),
          quantity: qty,
          productName: String(mat.productName ?? ""),
        });
      }

      const wastePct = totalMaterialsConsumed > 0 ? Math.round((totalWaste / totalMaterialsConsumed) * 10000) / 100 : 0;

      const byProductEntries = results.filter(
        (r) => r.type === "by_product" && Number(r.actualQuantity) > 0
      );
      const entryMovementCount = 1 + byProductEntries.length;
      const entryMovementCodes = await nextInventoryMovementCodes(
        db,
        accountId,
        companyId,
        entryMovementCount
      );
      const destMovementFields = productionOrderMovementFields(existing, "destination");
      const movementCtx = orderMovementContext(id, uid, accountId, companyId, destMovementFields);
      const fgUnitFirestore = finishedGoodResult
        ? unitFirestoreFromMaterial(finishedGoodResult)
        : {};

      const fgProductId = String(finishedGoodResult?.productId ?? "").trim();
      const stockEntryLines: StockEntryLine[] = [];
      if (fgProductId) {
        stockEntryLines.push({
          productId: fgProductId,
          productName: String(finishedGoodResult?.productName ?? ""),
          quantity: realQty,
          unitFirestore: fgUnitFirestore,
        });
      }
      for (const result of byProductEntries) {
        const productId = String(result.productId ?? "").trim();
        if (!productId) continue;
        stockEntryLines.push({
          productId,
          productName: String(result.productName ?? ""),
          quantity: Number(result.actualQuantity),
          unitFirestore: unitFirestoreFromMaterial(result),
        });
      }

      // Execute atomic transaction for entry movements + stock
      let entryCodeIndex = 0;
      await db.runTransaction(async (tx) => {
        const now = movementDateIso();
        const stockLocation = {
          locationId: destMovementFields.locationId,
          locationName: destMovementFields.locationName,
        };

        const stockTargets = stockEntryTargets(db, stockEntryLines, destWarehouseId);
        const stockSnaps = await Promise.all(stockTargets.map((t) => tx.get(t.ref)));

        if (fgProductId) {
          const fgEntryRef = db.collection("inventory-movements").doc();
          tx.set(fgEntryRef, {
            code: entryMovementCodes[entryCodeIndex++] ?? "",
            type: "entry",
            warehouseId: destWarehouseId,
            warehouseName: destMovementFields.warehouseName,
            productId: fgProductId,
            productName: String(finishedGoodResult?.productName ?? ""),
            quantity: realQty,
            ...fgUnitFirestore,
            ...movementCtx,
          });
        }

        for (const result of byProductEntries) {
          const bpRef = db.collection("inventory-movements").doc();
          tx.set(bpRef, {
            code: entryMovementCodes[entryCodeIndex++] ?? "",
            type: "entry",
            warehouseId: destWarehouseId,
            warehouseName: destMovementFields.warehouseName,
            productId: String(result.productId ?? ""),
            productName: String(result.productName ?? ""),
            quantity: Number(result.actualQuantity),
            ...unitFirestoreFromMaterial(result),
            ...movementCtx,
          });
        }

        writeStockEntryLines(
          tx,
          stockTargets,
          stockSnaps,
          destWarehouseId,
          destMovementFields.warehouseName,
          stockLocation,
          companyId,
          accountId,
          now
        );

        tx.update(orderRef, {
          status: "completada",
          realQuantityProduced: realQty,
          actualEndDate: new Date().toISOString().split("T")[0],
          yieldPercentage: yieldPct,
          wastePercentage: wastePct,
          updateAt: new Date(),
          updateBy: uid,
        });
      });

      updateEntitySearchIndex(db, {
        accountId, companyId,
        entityId: "production-order",
        action: "update",
        recordId: id,
        fields: { code: existing.code ?? "", finishedProductName: existing.finishedProductName ?? "", status: "completada" },
      }).catch(() => {});

      trackMetric(db, {
        accountId, companyId,
        metricKey: "production-orders-completed-count",
        delta: 1,
      }).catch(() => {});

      trackEntityChange(db, {
        accountId, companyId,
        collectionName: "production-orders",
        action: "update",
        document: { ...existing, status: "completada", realQuantityProduced: realQty },
        previousDocument: existing,
      }).catch(() => {});

      return res.status(200).json({ ok: true, status: "completada" });
    }

    // ── cancelada (from planificada or en_proceso) ──
    if (targetStatus === "cancelada") {
      // Generate reversal movements if order was en_proceso (had exit movements)
      if (currentStatus === "en_proceso") {
        // Re-read stock-levels and create entry movements for each material
        const orderMatSnap = await db.collection("production-orders").doc(id).collection("order-materials").get();
        const reversalMaterials = orderMatSnap.docs
          .map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>))
          .filter((mat) => {
            const productId = String(mat.productId ?? "").trim();
            const qty = Number(mat.requiredQuantity) || 0;
            return qty > 0 && !!productId;
          });

        const reversalCodes = await nextInventoryMovementCodes(
          db,
          accountId,
          companyId,
          reversalMaterials.length
        );
        const sourceWarehouseId = String(existing.sourceWarehouseId ?? "").trim();
        const sourceMovementFields = productionOrderMovementFields(existing, "source");
        const movementCtx = orderMovementContext(id, uid, accountId, companyId, sourceMovementFields);

        const reversalStockLines: StockEntryLine[] = reversalMaterials.map((mat) => ({
          productId: String(mat.productId ?? "").trim(),
          productName: String(mat.productName ?? ""),
          quantity: Number(mat.requiredQuantity) || 0,
          unitFirestore: unitFirestoreFromMaterial(mat),
        }));

        let reversalCodeIndex = 0;
        await db.runTransaction(async (tx) => {
          const now = movementDateIso();
          const stockLocation = {
            locationId: sourceMovementFields.locationId,
            locationName: sourceMovementFields.locationName,
          };

          const stockTargets = stockEntryTargets(db, reversalStockLines, sourceWarehouseId);
          const stockSnaps = await Promise.all(stockTargets.map((t) => tx.get(t.ref)));

          for (const mat of reversalMaterials) {
            const productId = String(mat.productId ?? "").trim();
            const qty = Number(mat.requiredQuantity) || 0;

            const movementRef = db.collection("inventory-movements").doc();
            tx.set(movementRef, {
              code: reversalCodes[reversalCodeIndex++] ?? "",
              type: "entry",
              warehouseId: sourceWarehouseId,
              warehouseName: sourceMovementFields.warehouseName,
              productId,
              productName: String(mat.productName ?? ""),
              quantity: qty,
              ...unitFirestoreFromMaterial(mat),
              reason: "Reversión por cancelación",
              ...movementCtx,
            });
          }

          writeStockEntryLines(
            tx,
            stockTargets,
            stockSnaps,
            sourceWarehouseId,
            sourceMovementFields.warehouseName,
            stockLocation,
            companyId,
            accountId,
            now
          );

          tx.update(orderRef, {
            status: "cancelada",
            updateAt: new Date(),
            updateBy: uid,
          });
        });
      } else {
        // planificada → cancelada (no movements to reverse)
        await orderRef.update({
          status: "cancelada",
          updateAt: new Date(),
          updateBy: uid,
        });
      }

      updateEntitySearchIndex(db, {
        accountId, companyId,
        entityId: "production-order",
        action: "update",
        recordId: id,
        fields: { code: existing.code ?? "", finishedProductName: existing.finishedProductName ?? "", status: "cancelada" },
      }).catch(() => {});

      return res.status(200).json({ ok: true, status: "cancelada" });
    }

    res.status(409).json({ error: "invalid_transition", message: `Transición no soportada: ${currentStatus} → ${targetStatus}` });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /orders/:id/transition error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Order Materials (read-only) ──────────────────────────────────────────────

// GET /production/orders/:id/materials
router.get("/orders/:id/materials", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const d = snap.data()!;
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const matSnap = await db.collection("production-orders").doc(id).collection("order-materials").get();
    const items = matSnap.docs.map((md) => toOrderMaterialRecord(md.data(), md.id));
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /orders/:id/materials error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Order Results ────────────────────────────────────────────────────────────

// GET /production/orders/:id/results
router.get("/orders/:id/results", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const d = snap.data()!;
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const resSnap = await db.collection("production-orders").doc(id).collection("order-results").get();
    const items = resSnap.docs.map((rd) => toOrderResultRecord(rd.data(), rd.id));
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /orders/:id/results error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/orders/:id/results/:resultId
router.put("/orders/:id/results/:resultId", async (req, res) => {
  try {
    const { companyId, uid } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id, resultId } = req.params;
    const body = req.body ?? {};

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const order = snap.data()!;
    if (String(order.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    // Only editable when order is en_proceso
    if (String(order.status ?? "").trim() !== "en_proceso") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede registrar resultados cuando la orden está en_proceso" });
    }

    const resSnap = await db.collection("production-orders").doc(id).collection("order-results").doc(resultId).get();
    if (!resSnap.exists) return res.status(404).json({ error: "not_found" });

    const updates: Record<string, unknown> = {};
    if (body.actualQuantity !== undefined) {
      const qty = Number(body.actualQuantity);
      if (qty < 0) return res.status(400).json({ error: "validation_error", message: "actualQuantity must be >= 0" });
      updates.actualQuantity = qty;
    }
    if (body.monetaryValue !== undefined) updates.monetaryValue = Number(body.monetaryValue) || 0;
    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("production-orders").doc(id).collection("order-results").doc(resultId).update(updates);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /orders/:id/results/:resultId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Costs Subcollection ──────────────────────────────────────────────────────

// GET /production/orders/:id/costs
router.get("/orders/:id/costs", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const d = snap.data()!;
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const costSnap = await db.collection("production-orders").doc(id).collection("costs").get();
    const items = costSnap.docs.map((cd) => toProductionCostRecord(cd.data(), cd.id));
    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /orders/:id/costs error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

async function recalcOrderCosts(
  db: FirebaseFirestore.Firestore,
  orderId: string,
  orderData: Record<string, unknown>,
  companyId: string,
  accountId: string,
  uid: string
): Promise<void> {
  // Calculate materialCost from order-materials (using unitCostAtCreation if available, or 0)
  const matSnap = await db.collection("production-orders").doc(orderId).collection("order-materials").get();
  let materialCost = 0;
  for (const matDoc of matSnap.docs) {
    const mat = matDoc.data();
    const qty = Number(mat.requiredQuantity) || 0;
    const unitCost = Number(mat.unitCostAtCreation) || 0;
    materialCost += qty * unitCost;
  }

  // Calculate direct labor and indirect costs from costs subcollection
  const costSnap = await db.collection("production-orders").doc(orderId).collection("costs").get();
  let directLaborTotal = 0;
  let indirectTotal = 0;

  for (const costDoc of costSnap.docs) {
    const c = costDoc.data();
    if (c.type === "direct_labor") {
      const hours = Number(c.hours) || 0;
      const rate = Number(c.hourlyRate) || 0;
      const amount = hours * rate;
      directLaborTotal += amount;
    } else if (c.type === "indirect") {
      const method = String(c.allocationMethod ?? "").trim();
      let amount = 0;
      if (method === "percentage") {
        amount = materialCost * (Number(c.percentage) || 0) / 100;
      } else if (method === "fixed") {
        amount = Number(c.fixedAmount) || 0;
      } else if (method === "proration") {
        amount = (Number(c.totalAmountForProration) || 0);
      }
      indirectTotal += amount;
    }
  }

  // Subtract by_product monetary values
  const resSnap = await db.collection("production-orders").doc(orderId).collection("order-results").get();
  let byProductValue = 0;
  for (const rDoc of resSnap.docs) {
    const r = rDoc.data();
    if (r.type === "by_product") {
      byProductValue += Number(r.monetaryValue) || 0;
    }
  }

  const totalCost = materialCost + directLaborTotal + indirectTotal - byProductValue;
  const realQty = Number(orderData.realQuantityProduced) || 0;
  const unitCost = realQty > 0 ? Math.round((totalCost / realQty) * 100) / 100 : null;

  await db.collection("production-orders").doc(orderId).update({
    materialCost: Math.round(materialCost * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    unitCost: unitCost !== null ? Math.round(unitCost * 100) / 100 : null,
    updateAt: new Date(),
    updateBy: uid,
  });
}

// POST /production/orders/:id/costs
router.post("/orders/:id/costs", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const { id } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const order = snap.data()!;
    if (String(order.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const status = String(order.status ?? "").trim();
    if (status !== "en_proceso" && status !== "completada") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede agregar costos en órdenes en_proceso o completadas" });
    }

    const costType = normalizeText(body.type) ?? "direct_labor";
    if (!["direct_labor", "indirect"].includes(costType)) {
      return res.status(400).json({ error: "validation_error", message: "type must be direct_labor or indirect" });
    }

    const concept = normalizeTextForFirestore(body.concept);
    if (!concept) return res.status(400).json({ error: "validation_error", message: "concept is required" });

    let amount = 0;
    const costDoc: Record<string, unknown> = {
      type: costType,
      concept,
      amount: 0,
      createAt: new Date(),
      createBy: uid,
      updateAt: new Date(),
      updateBy: uid,
    };

    if (costType === "direct_labor") {
      const hours = Number(body.hours) || 0;
      const hourlyRate = Number(body.hourlyRate) || 0;
      if (hours <= 0) return res.status(400).json({ error: "validation_error", message: "hours must be > 0" });
      if (hourlyRate <= 0) return res.status(400).json({ error: "validation_error", message: "hourlyRate must be > 0" });
      amount = hours * hourlyRate;
      costDoc.hours = hours;
      costDoc.hourlyRate = hourlyRate;
    } else {
      const allocationMethod = normalizeText(body.allocationMethod) ?? "fixed";
      if (!["percentage", "fixed", "proration"].includes(allocationMethod)) {
        return res.status(400).json({ error: "validation_error", message: "allocationMethod must be percentage, fixed, or proration" });
      }
      costDoc.allocationMethod = allocationMethod;
      if (allocationMethod === "percentage") {
        const pct = Number(body.percentage) || 0;
        if (pct <= 0) return res.status(400).json({ error: "validation_error", message: "percentage must be > 0" });
        costDoc.percentage = pct;
        amount = (Number(order.materialCost) || 0) * pct / 100;
      } else if (allocationMethod === "fixed") {
        const fixedAmt = Number(body.fixedAmount) || 0;
        if (fixedAmt <= 0) return res.status(400).json({ error: "validation_error", message: "fixedAmount must be > 0" });
        costDoc.fixedAmount = fixedAmt;
        amount = fixedAmt;
      } else {
        const totalAmt = Number(body.totalAmountForProration) || 0;
        if (totalAmt <= 0) return res.status(400).json({ error: "validation_error", message: "totalAmountForProration must be > 0" });
        costDoc.totalAmountForProration = totalAmt;
        amount = totalAmt;
      }
    }

    costDoc.amount = Math.round(amount * 100) / 100;

    const costRef = await db.collection("production-orders").doc(id).collection("costs").add(costDoc);

    // Recalc totalCost and unitCost
    await recalcOrderCosts(db, id, order, companyId, accountId, uid);

    res.status(201).json({ ok: true, id: costRef.id });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] POST /orders/:id/costs error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// PUT /production/orders/:id/costs/:costId
router.put("/orders/:id/costs/:costId", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id, costId } = req.params;
    const body = req.body ?? {};

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const order = snap.data()!;
    if (String(order.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const status = String(order.status ?? "").trim();
    if (status !== "en_proceso" && status !== "completada") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede editar costos en órdenes en_proceso o completadas" });
    }

    const costSnap = await db.collection("production-orders").doc(id).collection("costs").doc(costId).get();
    if (!costSnap.exists) return res.status(404).json({ error: "not_found" });

    const updates: Record<string, unknown> = {};
    if (body.concept !== undefined) updates.concept = normalizeTextForFirestore(body.concept);
    if (body.hours !== undefined) updates.hours = Number(body.hours) || 0;
    if (body.hourlyRate !== undefined) updates.hourlyRate = Number(body.hourlyRate) || 0;
    if (body.percentage !== undefined) updates.percentage = Number(body.percentage) || 0;
    if (body.fixedAmount !== undefined) updates.fixedAmount = Number(body.fixedAmount) || 0;
    if (body.totalAmountForProration !== undefined) updates.totalAmountForProration = Number(body.totalAmountForProration) || 0;
    if (body.allocationMethod !== undefined) updates.allocationMethod = normalizeText(body.allocationMethod) ?? "fixed";

    // Recalculate amount
    const existingCost = costSnap.data()!;
    const costType = String(existingCost.type ?? "").trim();
    let amount = 0;

    if (costType === "direct_labor") {
      const hours = Number(updates.hours ?? existingCost.hours) || 0;
      const rate = Number(updates.hourlyRate ?? existingCost.hourlyRate) || 0;
      amount = hours * rate;
    } else if (costType === "indirect") {
      const method = String(updates.allocationMethod ?? existingCost.allocationMethod ?? "fixed").trim();
      const materialCost = Number(order.materialCost) || 0;
      if (method === "percentage") {
        const pct = Number(updates.percentage ?? existingCost.percentage) || 0;
        amount = materialCost * pct / 100;
      } else if (method === "fixed") {
        amount = Number(updates.fixedAmount ?? existingCost.fixedAmount) || 0;
      } else {
        amount = Number(updates.totalAmountForProration ?? existingCost.totalAmountForProration) || 0;
      }
    }

    updates.amount = Math.round(amount * 100) / 100;
    updates.updateAt = new Date();
    updates.updateBy = uid;

    await db.collection("production-orders").doc(id).collection("costs").doc(costId).update(updates);

    // Recalc totalCost and unitCost
    await recalcOrderCosts(db, id, order, companyId, accountId, uid);

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] PUT /orders/:id/costs/:costId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// DELETE /production/orders/:id/costs/:costId
router.delete("/orders/:id/costs/:costId", async (req, res) => {
  try {
    const { companyId, uid, accountId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const { id, costId } = req.params;

    const snap = await db.collection("production-orders").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const order = snap.data()!;
    if (String(order.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const status = String(order.status ?? "").trim();
    if (status !== "en_proceso" && status !== "completada") {
      return res.status(409).json({ error: "invalid_transition", message: "Solo se puede eliminar costos en órdenes en_proceso o completadas" });
    }

    await db.collection("production-orders").doc(id).collection("costs").doc(costId).delete();

    // Recalc totalCost and unitCost
    await recalcOrderCosts(db, id, order, companyId, accountId, uid);

    res.status(200).json({ ok: true });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] DELETE /orders/:id/costs/:costId error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// ─── Planning ─────────────────────────────────────────────────────────────────

// GET /production/planning
router.get("/planning", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const dateFrom = normalizeText(req.query.dateFrom);
    const dateTo = normalizeText(req.query.dateTo);
    const statusFilter = normalizeText(req.query.status);
    const priorityFilter = normalizeText(req.query.priority);

    const snap = await db.collection("production-orders")
      .where("companyId", "==", companyId)
      .get();

    let items = snap.docs.map((d) => toProductionOrderRecord(d.data(), d.id));

    // Filter to planned/in_progress statuses for calendar
    items = items.filter((o) => o.status === "planificada" || o.status === "en_proceso");

    if (statusFilter) items = items.filter((o) => o.status === statusFilter);
    if (priorityFilter) items = items.filter((o) => o.priority === priorityFilter);
    if (dateFrom) items = items.filter((o) => String(o.plannedStartDate ?? "") >= dateFrom);
    if (dateTo) items = items.filter((o) => String(o.plannedStartDate ?? "") <= dateTo);

    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /planning error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

// GET /production/planning/materials-summary
router.get("/planning/materials-summary", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req);
    const db = getWebFirestore();
    const dateFrom = normalizeText(req.query.dateFrom);
    const dateTo = normalizeText(req.query.dateTo);

    const snap = await db.collection("production-orders")
      .where("companyId", "==", companyId)
      .get();

    let orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];

    // Filter to planned orders in date range
    orders = orders.filter((o) => {
      const s = String(o.status ?? "").trim();
      return s === "planificada" || s === "en_proceso";
    });

    if (dateFrom) orders = orders.filter((o) => String(o.plannedStartDate ?? "") >= dateFrom);
    if (dateTo) orders = orders.filter((o) => String(o.plannedStartDate ?? "") <= dateTo);

    // Aggregate materials by product
    const materialMap = new Map<string, { productId: string; productName: string; productCode: string; totalQuantity: number; unitOfMeasureCode: string; unitOfMeasureName: string; unitOfMeasureAbbreviation: string; orders: string[] }>();

    for (const order of orders) {
      const orderId = String(order.id ?? "");
      const matSnap = await db.collection("production-orders").doc(orderId).collection("order-materials").get();

      for (const matDoc of matSnap.docs) {
        const mat = matDoc.data();
        const productId = String(mat.productId ?? "").trim();
        if (!productId) continue;

        const key = productId;
        const qty = Number(mat.requiredQuantity) || 0;

        if (!materialMap.has(key)) {
          materialMap.set(key, {
            productId,
            productName: String(mat.productName ?? ""),
            productCode: String(mat.productCode ?? ""),
            totalQuantity: 0,
            unitOfMeasureCode: String(mat.unitOfMeasureCode ?? ""),
            unitOfMeasureName: String(mat.unitOfMeasureName ?? ""),
            unitOfMeasureAbbreviation: String(mat.unitOfMeasureAbbreviation ?? ""),
            orders: [],
          });
        }

        const entry = materialMap.get(key)!;
        entry.totalQuantity += qty;
        if (!entry.orders.includes(orderId)) {
          entry.orders.push(orderId);
        }
      }
    }

    const items = Array.from(materialMap.values()).map((m) => ({
      ...m,
      totalQuantity: Math.round(m.totalQuantity * 10000) / 10000,
    }));

    res.status(200).json({ items });
  } catch (err: any) {
    const msg = String(err?.message ?? "unknown_error");
    console.error("[production] GET /planning/materials-summary error:", msg);
    res.status(httpStatus(msg)).json({ error: msg });
  }
});

export default router;

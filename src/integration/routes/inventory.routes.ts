import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { toStockResponse } from "../mappers/stock.mapper.js";
import { toPriceResponse } from "../mappers/price.mapper.js";
import { problem } from "../integration-problem.js";

export const inventoryRouter = Router();

inventoryRouter.get("/stock", async (req, res) => {
  try {
    const companyId = String((req as any).companyId ?? "").trim();
    const db = getWebFirestore();
    const skusRaw = String(req.query.skus ?? "").trim();
    const skus = skusRaw ? skusRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) : [];
    let query: FirebaseFirestore.Query = db.collection("stock-levels").where("companyId", "==", companyId);
    if (skus.length > 0) {
      query = query.where("sku", "in", skus);
    }
    const snap = await query.get();
    const items = snap.docs.map((doc) => toStockResponse({ id: doc.id, ...doc.data() }));
    res.status(200).json({ data: items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/inventory/stock GET] failed:", msg);
    res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

inventoryRouter.get("/products/prices", async (req, res) => {
  try {
    const companyId = String((req as any).companyId ?? "").trim();
    const db = getWebFirestore();
    const skusRaw = String(req.query.skus ?? "").trim();
    const priceList = String(req.query.price_list ?? "web").trim();
    const skus = skusRaw ? skusRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) : [];

    if (skus.length === 0) {
      return res.status(200).json({ data: [] });
    }

    const productSnap = await db.collection("products")
      .where("companyId", "==", companyId)
      .where("sku", "in", skus.slice(0, 30))
      .get();

    const prices: ReturnType<typeof toPriceResponse>[] = [];
    for (const doc of productSnap.docs) {
      const data = doc.data() ?? {};
      prices.push(toPriceResponse({ ...data, priceListCode: priceList }));
    }

    const variantGroups = skus.slice(30).length > 0 ? skus.slice(30) : [];
    if (variantGroups.length > 0) {
      const variantSnap = await db.collectionGroup("variants")
        .where("companyId", "==", companyId)
        .where("sku", "in", variantGroups.slice(0, 30))
        .get();
      for (const doc of variantSnap.docs) {
        const data = doc.data() ?? {};
        prices.push(toPriceResponse({ ...data, priceListCode: priceList }));
      }
    }

    res.status(200).json({ data: prices });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/inventory/products/prices GET] failed:", msg);
    res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

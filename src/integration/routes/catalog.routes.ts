import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { toProductResponse } from "../mappers/product.mapper.js";
import { problem } from "../integration-problem.js";

export const catalogRouter = Router();

catalogRouter.get("/", async (req, res) => {
  try {
    const companyId = String((req as any).companyId ?? "").trim();
    const db = getWebFirestore();
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.per_page) || 20));
    const updatedSince = String(req.query.updated_since ?? "").trim();
    const category = String(req.query.category ?? "").trim();

    let query: FirebaseFirestore.Query = db.collection("products").where("companyId", "==", companyId);
    if (updatedSince) {
      const since = new Date(updatedSince);
      if (!isNaN(since.getTime())) {
        query = query.where("updateAt", ">=", since);
      }
    }
    if (category) {
      query = query.where("categoryPath", "array-contains", category);
    }

    const countSnap = await query.count().get();
    const total = countSnap.data().count;
    const totalPages = Math.ceil(total / perPage);

    query = query.orderBy("updateAt", "desc").offset((page - 1) * perPage).limit(perPage);
    const snap = await query.get();

    const products = await Promise.all(snap.docs.map(async (doc) => {
      const data = doc.data() ?? {};
      const variantsSnap = await db.collection("products").doc(doc.id).collection("variants").get();
      const variants = variantsSnap.docs.map((v) => ({ id: v.id, ...v.data() }));
      return await toProductResponse({ id: doc.id, ...data }, variants, db);
    }));

    const visibleProducts = products.filter(
      (p) => p.visible_in_store === true && p.sku && p.sku.trim().length > 0
    );

    res.status(200).json({
      data: visibleProducts,
      pagination: { total, page, per_page: perPage, total_pages: totalPages },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/catalog GET] failed:", msg);
    res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

catalogRouter.get("/:sku", async (req, res) => {
  try {
    const companyId = String((req as any).companyId ?? "").trim();
    const db = getWebFirestore();
    const { sku } = req.params;

    const productSnap = await db.collection("products")
      .where("companyId", "==", companyId)
      .where("sku", "==", sku)
      .limit(1)
      .get();

    if (!productSnap.empty) {
      const doc = productSnap.docs[0]!;
      const data = doc.data();
      const variantsSnap = await db.collection("products").doc(doc.id).collection("variants").get();
      const variants = variantsSnap.docs.map((v) => ({ id: v.id, ...v.data() }));
      return res.status(200).json(await toProductResponse({ id: doc.id, ...data }, variants, db));
    }

    const variantSnap = await db.collectionGroup("variants")
      .where("companyId", "==", companyId)
      .where("sku", "==", sku)
      .limit(1)
      .get();

    if (!variantSnap.empty) {
      const vDoc = variantSnap.docs[0]!;
      const vData = vDoc.data();
      const productId = String(vData.productId ?? "");
      const productDoc = await db.collection("products").doc(productId).get();
      if (productDoc.exists) {
        const pData = productDoc.data() ?? {};
        const allVariantsSnap = await db.collection("products").doc(productId).collection("variants").get();
        const allVariants = allVariantsSnap.docs.map((v) => ({ id: v.id, ...v.data() }));
        return res.status(200).json(await toProductResponse({ id: productDoc.id, ...pData }, allVariants, db));
      }
    }

    res.status(404).json(problem(404, `Product with SKU "${sku}" not found`, undefined, req.originalUrl));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[integration/catalog GET by sku] failed:", msg);
    res.status(500).json(problem(500, msg, undefined, req.originalUrl));
  }
});

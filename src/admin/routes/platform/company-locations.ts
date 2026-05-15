import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import { getUbigeoByCodeAndCountry } from "../../../data/ubigeos.js";

const SUBCOLLECTION = "companyLocations";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

async function ensureCompanyAccess(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyIdRaw: unknown
): Promise<string> {
  const companyId = String(companyIdRaw ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  const company = await db.collection("companies").doc(companyId).get();
  if (!company.exists) throw new Error("company_not_found");
  if (String(company.data()?.accountId ?? "").trim() !== accountId) {
    throw new Error("forbidden");
  }
  return companyId;
}

function toLocationRecord(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot) {
  const data = (doc.data() ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    companyId: String(data.companyId ?? ""),
    accountId: String(data.accountId ?? ""),
    name: String(data.name ?? ""),
    description: String(data.description ?? ""),
    ubigeo: String(data.ubigeo ?? ""),
    city: String(data.city ?? ""),
    country: String(data.country ?? ""),
    district: String(data.district ?? ""),
    address: String(data.address ?? ""),
    active: data.active !== false,
  };
}

const router = Router();

function resolveUbigeoOrThrow(ubigeoRaw: unknown, countryRaw: unknown): { code: string; name: string } {
  const row = getUbigeoByCodeAndCountry(ubigeoRaw, countryRaw);
  if (!row) throw new Error("ubigeo_invalid");
  return { code: row.code, name: row.name };
}

router.get("/company-locations", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const companyId = await ensureCompanyAccess(db, accountId, req.query.companyId);
    const snap = await db.collection("companies").doc(companyId).collection(SUBCOLLECTION).get();
    const items = snap.docs
      .map((doc) => toLocationRecord(doc))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    if (msg === "companyId_required") return res.status(400).json({ error: msg });
    if (msg === "company_not_found") return res.status(404).json({ error: msg });
    if (msg === "forbidden") return res.status(403).json({ error: msg });
    console.error("[admin/platform/company-locations GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/company-locations", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = await ensureCompanyAccess(db, accountId, body.companyId);
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });
    const country = String(body.country ?? "").trim() || "PE";
    const ubigeo = resolveUbigeoOrThrow(body.ubigeo, country);
    const district = String(body.district ?? "").trim() || ubigeo.name;
    const now = new Date();
    const docRef = db.collection("companies").doc(companyId).collection(SUBCOLLECTION).doc();
    await docRef.set({
      companyId,
      accountId,
      name,
      description: String(body.description ?? "").trim(),
      ubigeo: ubigeo.code,
      city: String(body.city ?? "").trim(),
      country,
      district,
      address: String(body.address ?? "").trim(),
      active: body.active !== false,
      createdAt: now,
      updatedAt: now,
    });
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    if (msg === "ubigeo_invalid") return res.status(422).json({ error: msg });
    if (msg === "companyId_required") return res.status(400).json({ error: msg });
    if (msg === "company_not_found") return res.status(404).json({ error: msg });
    if (msg === "forbidden") return res.status(403).json({ error: msg });
    console.error("[admin/platform/company-locations POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/company-locations/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = await ensureCompanyAccess(db, accountId, body.companyId ?? req.query.companyId);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "locationId_required" });
    const ref = db.collection("companies").doc(companyId).collection(SUBCOLLECTION).doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = String(body.name ?? "").trim();
    if (body.description !== undefined) patch.description = String(body.description ?? "").trim();
    if (body.ubigeo !== undefined) {
      const country = String(body.country ?? existing.data()?.country ?? "PE").trim() || "PE";
      const ubigeo = resolveUbigeoOrThrow(body.ubigeo, country);
      patch.ubigeo = ubigeo.code;
      if (body.district === undefined) {
        patch.district = ubigeo.name;
      }
    }
    if (body.city !== undefined) patch.city = String(body.city ?? "").trim();
    if (body.country !== undefined) patch.country = String(body.country ?? "").trim() || "PE";
    if (body.district !== undefined) patch.district = String(body.district ?? "").trim();
    if (body.address !== undefined) patch.address = String(body.address ?? "").trim();
    if (body.active !== undefined) patch.active = body.active !== false;
    await ref.update(patch);
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    if (msg === "ubigeo_invalid") return res.status(422).json({ error: msg });
    if (msg === "companyId_required" || msg === "locationId_required") {
      return res.status(400).json({ error: msg });
    }
    if (msg === "company_not_found" || msg === "not_found") return res.status(404).json({ error: msg });
    if (msg === "forbidden") return res.status(403).json({ error: msg });
    console.error("[admin/platform/company-locations PUT] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/company-locations/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const companyId = await ensureCompanyAccess(db, accountId, req.query.companyId);
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "locationId_required" });
    const ref = db.collection("companies").doc(companyId).collection(SUBCOLLECTION).doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });
    await ref.delete();
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    if (msg === "companyId_required" || msg === "locationId_required") {
      return res.status(400).json({ error: msg });
    }
    if (msg === "company_not_found" || msg === "not_found") return res.status(404).json({ error: msg });
    if (msg === "forbidden") return res.status(403).json({ error: msg });
    console.error("[admin/platform/company-locations DELETE] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

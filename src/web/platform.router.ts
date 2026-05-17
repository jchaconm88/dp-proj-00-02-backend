import { Router } from "express";
import { getWebFirestore } from "../lib/firebase-admin.js";
import { getUbigeoByCodeAndCountry } from "../data/ubigeos.js";

const router = Router();

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
  if (msg === "companyId_required" || msg === "validation_error" || msg === "id_required") return 400;
  return 500;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY LOCATIONS (scoped by companyId)
// ═══════════════════════════════════════════════════════════════════════════════

function toLocationRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const data = (doc.data() ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    companyId: String(data.companyId ?? ""),
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

router.get("/company-locations", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("companies").doc(companyId).collection("companyLocations").get();
    const items = snap.docs.map(toLocationRecord).sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(a.name).localeCompare(String(b.name)));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/company-locations GET] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

router.post("/company-locations", async (req, res) => {
  try {
    const { uid, accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "validation_error", message: "name is required" });

    const ubigeoCode = String(body.ubigeo ?? "").trim();
    const country = String(body.country ?? "").trim() || "PE";
    const ubigeo = getUbigeoByCodeAndCountry(ubigeoCode, country);
    const district = String(body.district ?? "").trim() || (ubigeo ? ubigeo.name : "");

    const now = new Date();
    const docRef = db.collection("companies").doc(companyId).collection("companyLocations").doc();
    await docRef.set({
      companyId,
      accountId,
      name,
      description: String(body.description ?? "").trim(),
      ubigeo: ubigeoCode,
      city: String(body.city ?? "").trim(),
      country,
      district,
      address: String(body.address ?? "").trim(),
      active: body.active !== false,
      createdAt: now,
      updatedAt: now,
      createBy: uid,
      updateBy: uid,
    });
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/company-locations POST] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

router.put("/company-locations/:id", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const ref = db.collection("companies").doc(companyId).collection("companyLocations").doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date(), updateBy: uid };
    if (body.name !== undefined) patch.name = String(body.name ?? "").trim();
    if (body.description !== undefined) patch.description = String(body.description ?? "").trim();
    if (body.ubigeo !== undefined) patch.ubigeo = String(body.ubigeo ?? "").trim();
    if (body.city !== undefined) patch.city = String(body.city ?? "").trim();
    if (body.country !== undefined) patch.country = String(body.country ?? "").trim() || "PE";
    if (body.district !== undefined) patch.district = String(body.district ?? "").trim();
    if (body.address !== undefined) patch.address = String(body.address ?? "").trim();
    if (body.active !== undefined) patch.active = body.active !== false;
    await ref.update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/company-locations/:id PUT] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

router.delete("/company-locations/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const ref = db.collection("companies").doc(companyId).collection("companyLocations").doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(200).json({ ok: true });
    await ref.delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/company-locations/:id DELETE] failed:", msg);
    return res.status(httpStatusForError(msg)).json({ error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USERS (platform profiles — collection "users")
// ═══════════════════════════════════════════════════════════════════════════════

function toUserRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = (doc.data() ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    email: String(d.email ?? ""),
    displayName: String(d.displayName ?? ""),
    phone: String(d.phone ?? ""),
    photoURL: String(d.photoURL ?? ""),
    status: normalizeStatus(d.status),
    roleIds: Array.isArray(d.roleIds) ? (d.roleIds as unknown[]).map((x) => String(x)) : [],
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

function normalizeStatus(value: unknown): "active" | "inactive" {
  return String(value ?? "").trim() === "inactive" ? "inactive" : "active";
}

router.get("/users", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("users").limit(200).get();
    const items = snap.docs
      .map(toUserRecord)
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (String(a.displayName || a.email)).localeCompare(String(b.displayName || b.email)));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/users GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("users").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toUserRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/users/:id GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/users", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "validation_error", message: "email is required" });

    const now = new Date();
    const docRef = db.collection("users").doc(); // auto-generated id
    await docRef.set({
      email,
      displayName: String(body.displayName ?? "").trim(),
      phone: String(body.phone ?? "").trim(),
      photoURL: String(body.photoURL ?? "").trim(),
      status: normalizeStatus(body.status),
      roleIds: Array.isArray(body.roleIds) ? (body.roleIds as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [],
      createdAt: now,
      updatedAt: now,
      createBy: uid,
    });
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/users POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/users/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date(), updateBy: uid };
    if (body.displayName !== undefined) patch.displayName = String(body.displayName ?? "").trim();
    if (body.phone !== undefined) patch.phone = String(body.phone ?? "").trim();
    if (body.photoURL !== undefined) patch.photoURL = String(body.photoURL ?? "").trim();
    if (body.status !== undefined) patch.status = normalizeStatus(body.status);
    if (body.roleIds !== undefined) {
      patch.roleIds = Array.isArray(body.roleIds) ? (body.roleIds as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
    }
    await db.collection("users").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/users/:id PUT] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists) return res.status(200).json({ ok: true });
    // Prevent deleting yourself
    if (id === uid) return res.status(403).json({ error: "forbidden", message: "cannot delete yourself" });
    await db.collection("users").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/users/:id DELETE] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE-MONTHS (by accountId + optional period)
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/usage-months/:accountId", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const accountId = String(req.params.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "validation_error", message: "accountId is required" });
    const period = String(req.query?.period ?? "").trim();
    const docId = period || new Date().toISOString().slice(0, 7); // yyyy-mm
    const snap = await db.collection("usage-months").doc(`${accountId}_${docId}`).get();
    if (!snap.exists) {
      // Try with just period as id (legacy format)
      const legacySnap = await db.collection("usage-months").doc(docId).get();
      if (!legacySnap.exists) return res.status(200).json(null);
      const data = legacySnap.data() ?? {};
      return res.status(200).json({
        id: legacySnap.id,
        accountId: String(data.accountId ?? accountId),
        period: docId,
        planUsage: data.planUsage ?? null,
        limits: data.limits ?? null,
      });
    }
    const data = snap.data() ?? {};
    return res.status(200).json({
      id: snap.id,
      accountId: String(data.accountId ?? accountId),
      period: docId,
      planUsage: data.planUsage ?? null,
      limits: data.limits ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/usage-months/:accountId GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAAS PLANS (global catalog — read-only + limits update)
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/saas-plans/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("plans").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    return res.status(200).json({
      id: snap.id,
      planId: String(data.planId ?? snap.id),
      name: String(data.name ?? ""),
      active: data.active !== false,
      limits: data.limits ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/saas-plans/:id GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/saas-plans/:id/limits", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("plans").doc(id).get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.limits || typeof body.limits !== "object") {
      return res.status(400).json({ error: "validation_error", message: "limits object is required" });
    }
    await db.collection("plans").doc(id).update({
      limits: body.limits,
      updatedAt: new Date(),
      updateBy: uid,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/saas-plans/:id/limits PUT] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COUNTERS (sequence counters)
// ═══════════════════════════════════════════════════════════════════════════════

function toCounterRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = (doc.data() ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    sequenceId: String(d.sequenceId ?? ""),
    counter: Number(d.counter) || 0,
    description: d.description ? String(d.description) : undefined,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

router.get("/counters", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const sequenceId = String(req.query?.sequenceId ?? "").trim();
    let query: FirebaseFirestore.Query = db.collection("counters");
    if (sequenceId) {
      query = query.where("sequenceId", "==", sequenceId);
    }
    const snap = await query.get();
    const items = snap.docs.map(toCounterRecord);
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/counters GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/counters/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("counters").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toCounterRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/counters/:id GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/counters", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sequenceId = String(body.sequenceId ?? "").trim();
    if (!sequenceId) return res.status(400).json({ error: "validation_error", message: "sequenceId is required" });

    const now = new Date();
    const docRef = db.collection("counters").doc();
    await docRef.set({
      sequenceId,
      counter: Number(body.counter) || 0,
      description: String(body.description ?? "").trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createBy: uid,
    });
    return res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/counters POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/counters/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("counters").doc(id).get();
    if (!existing.exists) return res.status(404).json({ error: "not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date(), updateBy: uid };
    if (body.sequenceId !== undefined) patch.sequenceId = String(body.sequenceId ?? "").trim();
    if (body.counter !== undefined) patch.counter = Number(body.counter) || 0;
    if (body.description !== undefined) {
      const trimmed = String(body.description ?? "").trim();
      patch.description = trimmed || null;
    }
    await db.collection("counters").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/counters/:id PUT] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/counters/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "validation_error", message: "id is required" });
    const existing = await db.collection("counters").doc(id).get();
    if (!existing.exists) return res.status(200).json({ ok: true });
    await db.collection("counters").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/platform/counters/:id DELETE] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

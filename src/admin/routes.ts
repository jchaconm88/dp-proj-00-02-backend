import { Router } from "express";
import { simpleRateLimit } from "../middlewares/rate-limit.js";
import { requireAdminAuth } from "../middlewares/admin-auth.js";
import { getAdminFirestore, getWebFirestore, getWebAuth } from "../lib/firebase-admin.js";
import { getAdminModules, getAdminModuleById, type ModuleRecord as AdminModuleRecord } from "../data/admin-modules.js";
import { getWebModules, getWebModuleById, type ModuleRecord as WebModuleRecord } from "../data/web-modules.js";
import {
  createCustomSequence,
  deleteCustomSequence,
  generateSequenceCode,
  getMergedSequenceById,
  listMergedSequences,
  updateCustomSequence,
} from "../lib/sequences.service.js";
import {
  createAdminCustomRole,
  createWebCustomRole,
  deleteAdminCustomRole,
  deleteWebCustomRole,
  getMergedAdminRoleById,
  getMergedWebRoleById,
  listMergedAdminRoles,
  listMergedWebRoles,
  roleHttpStatus,
  updateAdminCustomRole,
  updateWebCustomRole,
} from "../lib/merged-roles.service.js";
import { isWebDefaultRoleId } from "../data/web-roles.js";

export const adminRouter = Router();

adminRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "admin" }));

adminRouter.use(simpleRateLimit({ windowMs: 60_000, max: 600 }));

adminRouter.use(requireAdminAuth);

// Contexto del admin actual (uid/accountId/roles).
// Usado por el front para evitar depender de reglas de Firestore en el cliente.
adminRouter.get("/me", async (req, res) => {
  try {
    const admin = (req as any).admin as
      | { uid?: string; email?: string | null; accountId?: string; roleIds?: string[]; roleNames?: string[] }
      | undefined;
    if (!admin?.uid) return res.status(401).json({ error: "unauthenticated" });
    res.status(200).json({
      id: String(admin.uid),
      userId: String(admin.uid),
      accountId: String(admin.accountId ?? "").trim(),
      email: admin.email ?? "",
      displayName: "",
      status: String(admin.accountId ?? "").trim() ? "active" : "inactive",
      roleIds: Array.isArray(admin.roleIds) ? admin.roleIds : [],
      roleNames: Array.isArray(admin.roleNames) ? admin.roleNames : [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/me GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function sequenceHttpStatus(error: string): number {
  if (error === "default_sequence_readonly" || error === "entity_required" || error === "companyId_required") return 400;
  if (error === "sequence_entity_duplicate") return 409;
  if (error === "sequence_not_found") return 412;
  if (error === "not_found") return 404;
  return 500;
}

function generateAccountId(): string {
  // uuid if available, else fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require("crypto") as typeof import("crypto");
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // ignore
  }
  const a = Math.random().toString(36).slice(2);
  const b = Date.now().toString(36);
  return `acc_${b}_${a}`;
}

async function ensureAdminRole(db: FirebaseFirestore.Firestore, accountId: string, now: Date): Promise<string> {
  const snap = await db
    .collection("roles")
    .where("accountId", "==", accountId)
    .where("name", "==", "admin")
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0]!.id;
  const created = await db.collection("roles").add({
    accountId,
    name: "admin",
    description: "Administrador (bootstrap)",
    permissions: { "*": ["*"] },
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
}

async function upsertAdminUserDoc(db: FirebaseFirestore.Firestore, args: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  accountId: string;
  adminRoleId: string;
  now: Date;
}) {
  const { uid, email, displayName, accountId, adminRoleId, now } = args;
  await db.collection("users").doc(uid).set(
    {
      userId: uid,
      accountId,
      email: String(email ?? "").trim(),
      displayName: String(displayName ?? "").trim(),
      status: "active",
      roleIds: [adminRoleId],
      roleNames: ["admin"],
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );
}

adminRouter.get("/dashboard/snapshot", async (req, res) => {
  const accountId = String(req.query.accountId ?? "").trim();
  const period = String(req.query.period ?? "").trim();
  if (!accountId) return res.status(400).json({ error: "accountId_required" });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });
  const id = `${accountId}_${period}`;
  const snap = await getWebFirestore().collection("dashboard-snapshots").doc(id).get();
  // Para Admin, si aún no existe snapshot (p.ej. cuentas nuevas), devolvemos un snapshot vacío.
  if (!snap.exists) {
    return res.status(200).json({
      period,
      cards: [],
      activityReports: [],
      activityTrips: [],
      hasUsageForPeriod: false,
    });
  }
  const data = snap.data() ?? {};
  res.status(200).json({
    period: String((data as any).period ?? period),
    cards: Array.isArray((data as any).cards) ? (data as any).cards : [],
    activityReports: Array.isArray((data as any).activityReports) ? (data as any).activityReports : [],
    activityTrips: Array.isArray((data as any).activityTrips) ? (data as any).activityTrips : [],
    hasUsageForPeriod: Boolean((data as any).usage && typeof (data as any).usage === "object" && Object.keys((data as any).usage).length > 0),
  });
});

adminRouter.post("/dashboard/prepare-snapshot", async (_req, res) => {
  // En transición: el snapshot se sigue generando por Functions. Este endpoint queda para on-demand más adelante.
  res.status(200).json({ ok: true });
});

adminRouter.post("/onboarding/start", async (_req, res) => {
  res.status(200).json({ ok: true });
});

// ─── Onboarding status (single source of truth) ─────────────────────────────
adminRouter.get("/onboarding/status", async (_req, res) => {
  try {
    const req = _req as any;
    const admin = req.admin as { uid?: string; accountId?: string } | undefined;
    const uid = String(admin?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const accountId = String(admin?.accountId ?? "").trim();
    if (!accountId || accountId === "pending") {
      return res.status(200).json({
        ok: true,
        accountId: "",
        hasAccount: false,
        hasCompany: false,
        hasSubscription: false,
        // Stepper: 0 Cuenta, 1 Empresa, 2 Suscripción, 4 Usuario Web (opcional)
        nextStep: 0,
        completed: false,
      });
    }

    const db = getAdminFirestore();
    const webDb = getWebFirestore();

    const [companySnap, subsSnap] = await Promise.all([
      webDb.collection("companies").where("accountId", "==", accountId).limit(1).get(),
      db.collection("subscriptions").where("accountId", "==", accountId).limit(1).get(),
    ]);

    const hasCompany = !companySnap.empty;
    const hasSubscription = !subsSnap.empty;
    const completed = hasCompany && hasSubscription;

    const nextStep = !hasCompany ? 1 : !hasSubscription ? 2 : 4;

    res.status(200).json({
      ok: true,
      accountId,
      hasAccount: true,
      hasCompany,
      hasSubscription,
      completed,
      nextStep,
      companyId: hasCompany ? companySnap.docs[0]!.id : "",
      subscriptionId: hasSubscription ? subsSnap.docs[0]!.id : "",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/onboarding/status GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Task 7.1: Accounts CRUD ────────────────────────────────────────────────

adminRouter.get("/platform/accounts", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("accounts").doc(accountId).get();
    const items = snap.exists ? [{ id: snap.id, ...snap.data() }] : [];
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/accounts", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { name, status = "active", ...rest } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name_required" });
    await db.collection("accounts").doc(accountId).set({
      name: String(name).trim(),
      status: String(status),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id: accountId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/accounts/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    await db.collection("accounts").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/accounts/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    await db.collection("accounts").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Task 7.2: Companies CRUD ────────────────────────────────────────────────

/** Check taxId uniqueness in Web companies collection, optionally excluding a doc id. */
async function checkTaxIdUnique(taxId: string, excludeId?: string): Promise<boolean> {
  const db = getWebFirestore();
  const snap = await db.collection("companies").where("taxId", "==", taxId.trim()).limit(2).get();
  if (snap.empty) return true;
  if (excludeId) {
    // Allow if the only match is the doc being updated
    return snap.docs.every((doc) => doc.id === excludeId);
  }
  return false;
}

/** Check email uniqueness in Web users collection (global, across accounts). */
async function checkWebUserEmailUnique(email: string, excludeId?: string): Promise<boolean> {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return true;
  const db = getWebFirestore();
  const snap = await db.collection("users").where("email", "==", normalized).limit(2).get();
  if (snap.empty) return true;
  if (excludeId) {
    return snap.docs.every((doc) => doc.id === excludeId);
  }
  return false;
}

adminRouter.get("/platform/companies", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getWebFirestore();
    const snap = await db.collection("companies").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/companies", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = body.name;
    const status = body.status ?? "active";
    const taxId = body.taxId;
    const finalCode = String(body.code ?? "").trim();
    if (!name) return res.status(400).json({ error: "name_required" });
    if (!finalCode) return res.status(400).json({ error: "code_required" });
    if (finalCode.includes("/") || finalCode.includes("\0")) {
      return res.status(400).json({ error: "invalid_code", message: "El código no puede contener '/' ni caracteres inválidos" });
    }

    if (taxId) {
      const unique = await checkTaxIdUnique(String(taxId));
      if (!unique) {
        return res.status(409).json({ error: "taxid_duplicate", message: "Ya existe una empresa con ese RUC" });
      }
    }

    const codeDup = await db
      .collection("companies")
      .where("accountId", "==", accountId)
      .where("code", "==", finalCode)
      .limit(1)
      .get();
    if (!codeDup.empty) {
      return res.status(409).json({ error: "code_duplicate", message: "Ya existe una empresa con ese código" });
    }

    const docRef = await db.collection("companies").add({
      name: String(name).trim(),
      status: String(status),
      accountId,
      code: finalCode,
      ...(taxId !== undefined && taxId !== null && String(taxId).trim() !== ""
        ? { taxId: String(taxId).trim() }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    const created = {
      id: docRef.id,
      name: String(name).trim(),
      status: String(status),
      accountId,
      code: finalCode,
      ...(taxId !== undefined && taxId !== null && String(taxId).trim() !== ""
        ? { taxId: String(taxId).trim() }
        : {}),
    };
    res.status(201).json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// Helper: validar RUC/TaxId (para UI) sin leer Firestore desde el cliente.
adminRouter.get("/platform/companies/check-taxid", async (_req, res) => {
  try {
    const req = _req as any;
    requireAccountId(req);
    const taxId = String(req.query.taxId ?? "").trim();
    if (!taxId) return res.status(400).json({ error: "taxId_required" });
    const unique = await checkTaxIdUnique(taxId);
    res.status(200).json({ ok: true, unique });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies check-taxid GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/companies/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("companies").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    if (String(snap.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.status(200).json({ id: snap.id, ...snap.data() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/companies/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, taxId, ...fields } = req.body ?? {};
    const existing = await db.collection("companies").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (taxId !== undefined) {
      const unique = await checkTaxIdUnique(String(taxId), id);
      if (!unique) {
        return res.status(409).json({ error: "taxid_duplicate", message: "Ya existe una empresa con ese RUC" });
      }
      fields.taxId = String(taxId).trim();
    }

    await db.collection("companies").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/companies/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("companies").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("companies").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Admin Modules (catálogo de módulos del panel admin) ─────────────────────

adminRouter.get("/platform/admin-modules", (_req, res) => {
  try {
    const items: AdminModuleRecord[] = getAdminModules();
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/admin-modules GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/admin-modules/:id", (req, res) => {
  try {
    const mod = getAdminModuleById(req.params.id);
    if (!mod) return res.status(404).json({ error: "not_found" });
    res.status(200).json(mod);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/admin-modules/:id GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Web Modules (catálogo de módulos de la app web) ─────────────────────────

adminRouter.get("/platform/web-modules", (_req, res) => {
  try {
    const items: WebModuleRecord[] = getWebModules();
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-modules GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/web-modules/:id", (req, res) => {
  try {
    const mod = getWebModuleById(req.params.id);
    if (!mod) return res.status(404).json({ error: "not_found" });
    res.status(200).json(mod);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-modules/:id GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Admin Sequences (catálogo default + overrides por cuenta) ───────────────

adminRouter.get("/system/admin-sequences", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const items = await listMergedSequences(getAdminFirestore(), "admin", accountId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences GET] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.get("/system/admin-sequences/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const item = await getMergedSequenceById(getAdminFirestore(), "admin", accountId, req.params.id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences/:id GET] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.post("/system/admin-sequences", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const out = await createCustomSequence(getAdminFirestore(), "admin", accountId, req.body ?? {});
    res.status(201).json({ ok: true, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences POST] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.put("/system/admin-sequences/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    await updateCustomSequence(getAdminFirestore(), "admin", accountId, req.params.id, req.body ?? {});
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences PUT] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.delete("/system/admin-sequences/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    await deleteCustomSequence(getAdminFirestore(), "admin", accountId, req.params.id);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences DELETE] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.post("/system/admin-sequences/generate-code", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const code = await generateSequenceCode(
      getAdminFirestore(),
      "admin",
      accountId,
      String(req.body?.entity ?? ""),
      String(req.body?.currentCode ?? "")
    );
    res.status(200).json({ code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences/generate-code POST] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

// ─── Task 7.3: Plans CRUD ────────────────────────────────────────────────────

adminRouter.get("/platform/plans", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("saas-plans").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/plans", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, name, planId, active = true, limits, features, ...rest } = req.body ?? {};
    if (!id || !name) return res.status(400).json({ error: "id_and_name_required" });
    await db.collection("saas-plans").doc(String(id).trim()).set({
      name: String(name).trim(),
      planId: String(planId ?? id).trim(),
      accountId,
      active: Boolean(active),
      ...(limits !== undefined && { limits }),
      ...(features !== undefined && { features }),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/plans/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    const existing = await db.collection("saas-plans").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("saas-plans").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/plans/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("saas-plans").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("saas-plans").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Task 7.4: Subscriptions CRUD ───────────────────────────────────────────

adminRouter.get("/platform/subscriptions", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("subscriptions").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/subscriptions", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, planId, status = "active", ...rest } = req.body ?? {};
    if (!id || !planId) return res.status(400).json({ error: "id_and_planId_required" });
    await db.collection("subscriptions").doc(String(id).trim()).set({
      accountId,
      planId: String(planId).trim(),
      status: String(status),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/subscriptions/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, ...fields } = req.body ?? {};
    const existing = await db.collection("subscriptions").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("subscriptions").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/subscriptions/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("subscriptions").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("subscriptions").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Task 7.6: Roles (Admin) — merge catálogo TS + colección `roles` ─────────

adminRouter.get("/platform/roles", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const items = await listMergedAdminRoles(db, accountId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/roles GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const item = await getMergedAdminRoleById(db, accountId, id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/roles GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/roles", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = await createAdminCustomRole(db, accountId, req.body ?? {});
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/roles POST] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.put("/platform/roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    await updateAdminCustomRole(db, accountId, id, req.body ?? {});
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/roles PUT] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.delete("/platform/roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    await deleteAdminCustomRole(db, accountId, id);
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/roles DELETE] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

// ─── Task 7.7: Users CRUD (Admin) ───────────────────────────────────────────

adminRouter.get("/platform/users", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db.collection("users").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String((data as any).accountId ?? "") !== accountId) return res.status(403).json({ error: "forbidden" });
    res.status(200).json({ id: snap.id, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/users", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, userId, email = "", displayName = "", status = "active", roleIds = [], roleNames = [], ...rest } =
      req.body ?? {};
    if (!id) return res.status(400).json({ error: "id_required" });
    await db.collection("users").doc(String(id).trim()).set(
      {
        userId: String(userId ?? id).trim(),
        accountId,
        email: String(email).trim(),
        displayName: String(displayName).trim(),
        status: String(status).trim() === "inactive" ? "inactive" : "active",
        roleIds: Array.isArray(roleIds) ? roleIds : [],
        roleNames: Array.isArray(roleNames) ? roleNames : [],
        ...rest,
        updatedAt: now,
        createdAt: now,
      },
      { merge: true }
    );
    res.status(201).json({ ok: true, id: String(id).trim() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const { id: _id, createdAt: _ca, accountId: _aid, userId: _uid, ...fields } = req.body ?? {};
    await db.collection("users").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("users").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Task 7.x: Company Users (CRUD, scoped por accountId) ───────────────────

adminRouter.get("/platform/company-users", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getWebFirestore();
    const companyId = String(req.query.companyId ?? "").trim();
    if (companyId) {
      const company = await db.collection("companies").doc(companyId).get();
      if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
        return res.status(403).json({ error: "forbidden" });
      }
    }
    const snap = await db.collection("company-users").where("accountId", "==", accountId).get();
    let items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (companyId) {
      items = items.filter((row: any) => String(row.companyId ?? "") === companyId);
    }
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/company-users", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const companyId = String(req.body?.companyId ?? "").trim();
    const userId = String(req.body?.userId ?? "").trim();
    if (!companyId || !userId) return res.status(400).json({ error: "companyId_and_userId_required" });

    const company = await db.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const usersDocId = req.body?.usersDocId !== undefined ? String(req.body.usersDocId).trim() : "";
    const userEmail =
      req.body?.userEmail !== undefined ? String(req.body.userEmail).trim().toLowerCase() : "";
    const userDisplayName =
      req.body?.userDisplayName !== undefined ? String(req.body.userDisplayName).trim() : "";
    const user = req.body?.user !== undefined ? String(req.body.user).trim() : "";
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map((x: unknown) => String(x)) : [];
    const roleNames = Array.isArray(req.body?.roleNames) ? req.body.roleNames.map((x: unknown) => String(x)) : [];
    const status = String(req.body?.status ?? "active").trim() === "inactive" ? "inactive" : "active";

    const id = `${companyId}_${userId}`;
    const docRef = db.collection("company-users").doc(id);
    const existing = await docRef.get();
    if (existing.exists) {
      return res.status(409).json({
        error: "company_user_exists",
        message: "Ya existe un usuario de empresa para este usuario en la empresa.",
      });
    }

    await docRef.set({
      companyId,
      accountId,
      userId,
      ...(usersDocId && { usersDocId }),
      ...(userEmail && { userEmail }),
      ...(userDisplayName && { userDisplayName }),
      ...(user && { user }),
      roleIds,
      roleNames,
      status,
      createAt: now,
      updateAt: now,
      createBy: "admin",
      updateBy: "admin",
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/company-users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("company-users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    if (String(snap.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const patch: Record<string, unknown> = { updateAt: now, updateBy: "admin" };
    const body = req.body ?? {};
    if (body.user !== undefined) patch.user = String(body.user).trim();
    if (body.userEmail !== undefined) patch.userEmail = String(body.userEmail).trim().toLowerCase();
    if (body.userDisplayName !== undefined) patch.userDisplayName = String(body.userDisplayName).trim();
    if (body.usersDocId !== undefined) patch.usersDocId = String(body.usersDocId).trim();
    if (Array.isArray(body.roleIds)) patch.roleIds = body.roleIds.map((x: unknown) => String(x));
    if (Array.isArray(body.roleNames)) patch.roleNames = body.roleNames.map((x: unknown) => String(x));
    if (body.status !== undefined) {
      patch.status = String(body.status).trim() === "inactive" ? "inactive" : "active";
    }
    await db.collection("company-users").doc(id).update(patch);
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/company-users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("company-users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    if (String(snap.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("company-users").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Firestore Web: app users (`users`) — distintos del staff en Admin ───────

adminRouter.get("/platform/web-users", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const wDb = getWebFirestore();
    const snap = await wDb.collection("users").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        authUid: String(data.authUid ?? doc.id).trim(),
        email: String(data.email ?? "").trim(),
        displayName: String(data.displayName ?? "").trim(),
        accountId: String(data.accountId ?? "").trim() || undefined,
        status: String(data.status ?? "active").trim(),
      };
    });
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/web-users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    const snap = await wDb.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String((data as any).accountId ?? "") !== accountId) return res.status(403).json({ error: "forbidden" });
    res.status(200).json({ id: snap.id, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

function generateRandomPassword(length: number = 16): string {
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const symbols = "!@#$%^&*";
  const all = lowercase + uppercase + digits + symbols;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += all[bytes[i] % all.length];
  }
  return password;
}

adminRouter.post("/platform/web-users", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const wAuth = getWebAuth();
    const now = new Date();
    const { email = "", displayName = "", status = "active", password } = req.body ?? {};
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: "email_required" });

    const unique = await checkWebUserEmailUnique(normalizedEmail);
    if (!unique) {
      return res.status(409).json({ error: "email_duplicate", message: "Ya existe un usuario con ese email" });
    }

    // Generate random password if not provided
    const userPassword = String(password ?? "").trim() || generateRandomPassword(16);

    // Crear cuenta Firebase Auth para obtener uid canónico
    let authUid: string;
    try {
      const userRecord = await wAuth.createUser({
        email: normalizedEmail,
        displayName: String(displayName).trim() || undefined,
        password: userPassword,
        emailVerified: false,
      });
      authUid = userRecord.uid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown_error";
      if (msg.includes("EMAIL_EXISTS") || msg.includes("email-already-exists")) {
        return res.status(409).json({ error: "email_duplicate", message: "Ya existe un usuario con ese email" });
      }
      console.error("[admin/platform/web-users POST] auth.createUser failed:", msg);
      return res.status(500).json({ error: "internal", message: "No se pudo crear la cuenta de autenticación" });
    }

    const payload = {
      email: normalizedEmail,
      authUid,
      displayName: String(displayName).trim(),
      status: String(status).trim() === "inactive" ? "inactive" : "active",
      accountId,
      updatedAt: now,
      createdAt: now,
    };

    // authUid como doc ID canónico
    await wDb.collection("users").doc(authUid).set(payload);
    return res.status(201).json({ ok: true, id: authUid, authUid, generatedPassword: userPassword });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.put("/platform/web-users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    const existing = await wDb.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const { id: _id, createdAt: _ca, accountId: _aid, email, ...fields } = req.body ?? {};
    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!normalizedEmail) return res.status(400).json({ error: "email_required" });
      const unique = await checkWebUserEmailUnique(normalizedEmail, id);
      if (!unique) {
        return res.status(409).json({ error: "email_duplicate", message: "Ya existe un usuario con ese email" });
      }
      (fields as any).email = normalizedEmail;
    }
    await wDb.collection("users").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.delete("/platform/web-users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const wAuth = getWebAuth();
    const { id } = req.params;
    const existing = await wDb.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Delete Firebase Auth user (id is the authUid)
    const authUid = String(existing.data()?.authUid ?? id).trim();
    try {
      await wAuth.deleteUser(authUid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown_error";
      if (!msg.includes("NOT_FOUND") && !msg.includes("user-not-found")) {
        console.warn("[admin/platform/web-users DELETE] auth.deleteUser warning:", msg);
      }
    }

    await wDb.collection("users").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Firestore Web: roles por empresa (merge catálogo + `roles`) ───────────

adminRouter.get("/platform/web-roles", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const companyId = String(req.query.companyId ?? "").trim();
    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    const wDb = getWebFirestore();
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const items = await listMergedWebRoles(wDb, accountId, companyId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.get("/platform/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    let companyId = String(req.query.companyId ?? "").trim();
    if (isWebDefaultRoleId(id) && !companyId) {
      return res.status(400).json({ error: "companyId_required" });
    }
    if (!isWebDefaultRoleId(id)) {
      const snap = await wDb.collection("roles").doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "not_found" });
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const item = await getMergedWebRoleById(wDb, accountId, companyId, id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

adminRouter.post("/platform/web-roles", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { companyId, name } = req.body ?? {};
    const cid = String(companyId ?? "").trim();
    if (!cid || !name) return res.status(400).json({ error: "companyId_and_name_required" });
    const company = await wDb.collection("companies").doc(cid).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const { id } = await createWebCustomRole(wDb, accountId, cid, {
      ...(req.body ?? {}),
      createBy: "admin",
      updateBy: "admin",
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles POST] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.put("/platform/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    const snap = await wDb.collection("roles").doc(id).get();
    if (!snap.exists && !isWebDefaultRoleId(id)) return res.status(404).json({ error: "not_found" });
    let companyId = String(req.query.companyId ?? (req.body as any)?.companyId ?? "").trim();
    if (!isWebDefaultRoleId(id)) {
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    } else {
      if (!companyId) return res.status(400).json({ error: "companyId_required" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await updateWebCustomRole(wDb, accountId, companyId, id, { ...(req.body ?? {}), updateBy: "admin" });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles PUT] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

adminRouter.delete("/platform/web-roles/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    let companyId = String(req.query.companyId ?? "").trim();
    if (!isWebDefaultRoleId(id)) {
      const snap = await wDb.collection("roles").doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "not_found" });
      const data = snap.data() ?? {};
      companyId = String((data as any).companyId ?? "").trim();
      if (!companyId) return res.status(403).json({ error: "forbidden" });
    } else {
      if (!companyId) return res.status(400).json({ error: "companyId_required" });
    }
    const company = await wDb.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await deleteWebCustomRole(wDb, accountId, companyId, id);
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-roles DELETE] failed:", msg);
    res.status(roleHttpStatus(msg)).json({ error: msg });
  }
});

// ─── Task 7.5: Extended onboarding/complete ─────────────────────────────────

adminRouter.post("/onboarding/complete", async (req, res) => {
  try {
    const decoded = (req as any).auth as { uid?: string; email?: string; name?: string } | undefined;
    const bodyUid = String(req.body?.uid ?? "").trim();
    const uid = String(decoded?.uid ?? bodyUid ?? (req as any)?.admin?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const requestedAccountId = String(req.body?.accountId ?? "").trim();
    const accountId = requestedAccountId || generateAccountId();
    const accountName = String(req.body?.accountName ?? "").trim() || "Cuenta";

    const db = getAdminFirestore();
    const now = new Date();

    await db.collection("accounts").doc(accountId).set(
      {
        name: accountName,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    const adminRoleId = await ensureAdminRole(db, accountId, now);
    const bodyEmail = req.body?.email !== undefined ? String(req.body.email).trim() : null;
    const bodyDisplayName = req.body?.displayName !== undefined ? String(req.body.displayName).trim() : null;
    await upsertAdminUserDoc(db, {
      uid,
      email: decoded?.email ?? bodyEmail ?? null,
      displayName: decoded?.name ?? bodyDisplayName ?? null,
      accountId,
      adminRoleId,
      now,
    });

    res.status(200).json({ ok: true, accountId, adminRoleId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    // eslint-disable-next-line no-console
    console.error("[admin/onboarding/complete] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

/**
 * Crea en Firestore Web (batch atómico): empresa, primer usuario app, rol admin de empresa y company-member.
 * El doc `users` usa el email como id (mismo criterio que invitaciones).
 */
adminRouter.post("/onboarding/bootstrap-web-tenant", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const now = new Date();
    const companyId = String(req.body?.companyId ?? req.body?.id ?? "").trim();
    const name = String(req.body?.companyName ?? req.body?.name ?? "").trim();
    const webUserEmail = String(req.body?.webUserEmail ?? req.body?.firstUserEmail ?? "").trim().toLowerCase();
    const webUserDisplayName = String(req.body?.webUserDisplayName ?? req.body?.firstUserDisplayName ?? "").trim();
    const taxId = req.body?.taxId !== undefined ? String(req.body.taxId).trim() : "";
    const code = req.body?.code !== undefined ? String(req.body.code).trim() : "";

    if (!companyId || !name) return res.status(400).json({ error: "companyId_and_name_required" });
    if (!webUserEmail) return res.status(400).json({ error: "webUserEmail_required" });

    if (taxId) {
      const unique = await checkTaxIdUnique(taxId);
      if (!unique) {
        return res.status(409).json({ error: "taxid_duplicate", message: "Ya existe una empresa con ese RUC" });
      }
    }

    const companyRef = wDb.collection("companies").doc(companyId);
    const existingCompany = await companyRef.get();
    if (existingCompany.exists) {
      return res.status(409).json({ error: "company_exists", message: "Ya existe una empresa con ese id" });
    }

    const roleRef = wDb.collection("roles").doc();
    const userRef = wDb.collection("users").doc(webUserEmail);
    const companyUserDocId = `${companyId}_${webUserEmail}`;
    const memberRef = wDb.collection("company-users").doc(companyUserDocId);

    const batch = wDb.batch();
    batch.set(companyRef, {
      name,
      status: "active",
      accountId,
      ...(taxId ? { taxId } : {}),
      ...(code ? { code } : {}),
      createdAt: now,
      updatedAt: now,
    });
    batch.set(roleRef, {
      companyId,
      accountId,
      name: "admin",
      description: "Administrador (bootstrap web)",
      permissions: { "*": ["*"] },
      createdAt: now,
      updateAt: now,
      createBy: "admin",
      updateBy: "admin",
    });
    batch.set(
      userRef,
      {
        email: webUserEmail,
        displayName: webUserDisplayName,
        accountId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    batch.set(memberRef, {
      companyId,
      accountId,
      userId: webUserEmail,
      userEmail: webUserEmail,
      ...(webUserDisplayName ? { userDisplayName: webUserDisplayName } : {}),
      roleIds: [roleRef.id],
      roleNames: ["admin"],
      status: "active",
      createAt: now,
      updateAt: now,
      createBy: "admin",
      updateBy: "admin",
    });
    await batch.commit();

    res.status(201).json({
      ok: true,
      companyId,
      webUserId: webUserEmail,
      webRoleId: roleRef.id,
      companyUserDocId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/onboarding/bootstrap-web-tenant POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Web: Invites ────────────────────────────────────────────────────────────

adminRouter.post("/web/invites", async (req, res) => {
  try {
    const admin = (req as any).admin as { accountId?: string } | undefined;
    const accountId = String(admin?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId_required" });

    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const displayName = String(req.body?.displayName ?? "").trim();
    const companyId = String(req.body?.companyId ?? "").trim() || accountId;
    if (!email) return res.status(400).json({ error: "email_required" });

    const db = getWebFirestore();
    const now = new Date();

    // 1) Preauthorize in web/users (docId = email)
    await db.collection("users").doc(email).set(
      {
        email,
        displayName,
        accountId,
        status: "invited",
        invitedAt: now,
        updatedAt: now,
        createdAt: now,
      },
      { merge: true }
    );

    // 2) Ensure web admin role for the company
    let adminRoleId: string | null = null;
    const roleSnap = await db
      .collection("roles")
      .where("companyId", "==", companyId)
      .where("name", "==", "admin")
      .limit(1)
      .get();
    if (!roleSnap.empty) {
      adminRoleId = roleSnap.docs[0]!.id;
    } else {
      const created = await db.collection("roles").add({
        companyId,
        accountId,
        name: "admin",
        description: "Administrador (bootstrap web)",
        permissions: { "*": ["*"] },
        createdAt: now,
        updateAt: now,
        createBy: "admin",
        updateBy: "admin",
      });
      adminRoleId = created.id;
    }

    // 3) Create company-users doc (use email as userId until auth uid is resolved)
    const companyUserDocId = `${companyId}_${email}`;
    await db.collection("company-users").doc(companyUserDocId).set(
      {
        companyId,
        accountId,
        userId: email,
        userEmail: email,
        userDisplayName: displayName,
        roleIds: [adminRoleId],
        roleNames: ["admin"],
        status: "active",
        createAt: now,
        updateAt: now,
        createBy: "admin",
        updateBy: "admin",
      },
      { merge: true }
    );

    // 4) Create invite token (stub: token returned; email send TBD)
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const inviteId = `${companyId}_${Date.now()}_${token.slice(0, 8)}`;
    await db.collection("invites").doc(inviteId).set(
      {
        inviteId,
        email,
        companyId,
        accountId,
        status: "pending",
        token,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    res.status(201).json({ ok: true, inviteId, token, email, companyId, accountId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/web/invites POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

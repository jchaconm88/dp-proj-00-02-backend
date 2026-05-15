import { Router } from "express";
import { requireWebAuth } from "../middlewares/web-auth.js";
import { getWebFirestore } from "../lib/firebase-admin.js";
import {
  createCustomSequence,
  deleteCustomSequence,
  generateSequenceCode,
  getMergedSequenceById,
  listMergedSequences,
  updateCustomSequence,
} from "../lib/sequences.service.js";
import {
  createWebCustomRole,
  deleteWebCustomRole,
  getMergedWebRoleById,
  listMergedWebRoles,
  roleHttpStatus,
  updateWebCustomRole,
} from "../lib/merged-roles.service.js";
import webDashboardConfigRouter from "../features/dashboard/web-dashboard-config.routes.js";
import dashboardSnapshotRouter from "../features/dashboard/dashboard-snapshot.routes.js";
import purchasingRouter from "./purchasing.router.js";
import salesRouter from "./sales.router.js";
import inventoryRouter from "./inventory.router.js";
import { adjustCount } from "../features/dashboard/tenant-stats.service.js";
import {
  getDocumentTypesByCountryAndType,
  parseDocumentTypeCategory,
  parseDocumentTypeCountry,
  getDocumentTypeByIdAndScope,
} from "../data/document-types.js";
import {
  getCountryByCode,
  filterAllowedCurrenciesByCountry,
  type CountryCode,
} from "../data/countries.js";
import {
  getCurrencyByCode,
  getCurrenciesCatalog,
  parseCurrencyCode,
  type CurrencyCode,
} from "../data/currencies.js";
import { getUnitsOfMeasureCatalog } from "../data/units-of-measure.js";
import {
  getUbigeoByCodeAndCountry,
  getUbigeosByCountry,
  parseUbigeoCountry,
} from "../data/ubigeos.js";

// NOTE: adjustCount is integrated for tracked collections that have create/delete endpoints:
// trips, settlements, invoices, clients, employees, vehicles, drivers, orders, suppliers, purchase-orders, quotations, sale-orders.
// The following tracked collections do NOT have create/delete endpoints yet:
// - report-runs: integrate adjustCount(db, { accountId, companyId, metricKey: "report-runs", delta: 1 }) when endpoint is created
// - email-log: integrate adjustCount(db, { accountId, companyId, metricKey: "emails-sent", delta: 1 }) when endpoint is created
// - storage-usage: integrate adjustCount(db, { accountId, companyId, metricKey: "storage-bytes-used", delta: <bytes> }) when endpoint is created

export const webRouter = Router();

webRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "web" }));

webRouter.use(requireWebAuth);

webRouter.use("/dashboard-config", webDashboardConfigRouter);
webRouter.use("/dashboard", dashboardSnapshotRouter);
webRouter.use("/purchasing", purchasingRouter);
webRouter.use("/sales", salesRouter);
webRouter.use("/inventory", inventoryRouter);

/** Perfil del usuario de sesiÃ³n (doc `users/{authUid}` en Firestore Web). */
webRouter.get("/me", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    logWebApi("me:start", { uidPrefix: uid ? `${uid.slice(0, 6)}â€¦` : "(missing)" });
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("users").doc(uid).get();
    logWebApi("me:users-doc", { exists: snap.exists, docId: uid });
    if (!snap.exists) return res.status(403).json({ error: "forbidden", message: "Acceso restringido: tu usuario debe ser creado desde Admin." });
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    return res.status(200).json({
      authUid: uid,
      usersDocId: snap.id,
      email: String(data.email ?? ""),
      displayName: String(data.displayName ?? ""),
      roleIds: Array.isArray(data.roleIds) ? (data.roleIds as unknown[]).map((x) => String(x)) : [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/me GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

function webApiDebug(): boolean {
  const v = String(process.env.WEB_API_DEBUG ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function logWebApi(event: string, data: Record<string, unknown>): void {
  if (!webApiDebug()) return;
  // eslint-disable-next-line no-console
  console.log(`[web-api] ${event}`, data);
}

function sequenceHttpStatus(error: string): number {
  if (error === "default_sequence_readonly" || error === "entity_required" || error === "companyId_required") return 400;
  if (error === "sequence_entity_duplicate") return 409;
  if (error === "sequence_not_found") return 412;
  if (error === "not_found") return 404;
  return 500;
}

async function requireCompanyScope(req: any): Promise<{ uid: string; accountId: string; companyId: string }> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const companyId = String(req.query?.companyId ?? req.body?.companyId ?? "").trim();
  if (!companyId) throw new Error("companyId_required");
  logWebApi("requireCompanyScope:start", {
    companyId,
    uidPrefix: uid.length > 6 ? `${uid.slice(0, 6)}â€¦` : uid,
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

function normalizeStatus(value: unknown): "active" | "inactive" {
  return String(value ?? "").trim() === "inactive" ? "inactive" : "active";
}

function normalizeText(value: unknown): string | undefined {
  const out = String(value ?? "").trim();
  return out || undefined;
}

function toCompanyCurrencyConfig(d: Record<string, unknown>): {
  countryCode: CountryCode | null;
  allowedCurrencies: CurrencyCode[];
  defaultCurrency: CurrencyCode | null;
} {
  const country = getCountryByCode(d.countryCode);
  if (!country) return { countryCode: null, allowedCurrencies: [], defaultCurrency: null };
  const allowed = filterAllowedCurrenciesByCountry(country.code, d.allowedCurrencies) ?? [];
  const defaultCurrency = parseCurrencyCode(d.defaultCurrency);
  if (!defaultCurrency || !allowed.includes(defaultCurrency)) {
    return { countryCode: null, allowedCurrencies: [], defaultCurrency: null };
  }
  return { countryCode: country.code, allowedCurrencies: allowed, defaultCurrency };
}

async function getCompanyCurrencyConfigOrThrow(db: FirebaseFirestore.Firestore, companyId: string): Promise<{
  countryCode: CountryCode;
  allowedCurrencies: CurrencyCode[];
  defaultCurrency: CurrencyCode;
}> {
  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) throw new Error("company_not_found");
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const cfg = toCompanyCurrencyConfig(data);
  if (!cfg.countryCode || cfg.allowedCurrencies.length === 0 || !cfg.defaultCurrency) {
    throw new Error("company_currency_config_missing");
  }
  return {
    countryCode: cfg.countryCode,
    allowedCurrencies: cfg.allowedCurrencies,
    defaultCurrency: cfg.defaultCurrency,
  };
}

async function normalizeCurrencyOrThrow(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  currencyRaw: unknown
): Promise<CurrencyCode> {
  const config = await getCompanyCurrencyConfigOrThrow(db, companyId);
  const parsed = parseCurrencyCode(currencyRaw);
  const selected = parsed ?? config.defaultCurrency;
  if (!config.allowedCurrencies.includes(selected)) {
    throw new Error("currency_not_allowed");
  }
  return selected;
}

function toCompanyUserRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const data = (doc.data() ?? {}) as Record<string, unknown>;
  const inferredUserId = doc.id.includes("_") ? doc.id.split("_").slice(1).join("_").trim() : "";
  const userId = String(data.userId ?? "").trim() || inferredUserId;
  return {
    id: doc.id,
    companyId: String(data.companyId ?? ""),
    accountId: normalizeText(data.accountId),
    userId,
    user:
      normalizeText(data.user) ||
      normalizeText(data.userDisplayName) ||
      normalizeText(data.userEmail) ||
      userId ||
      undefined,
    usersDocId: normalizeText(data.usersDocId),
    userEmail: normalizeText(data.userEmail),
    userDisplayName: normalizeText(data.userDisplayName),
    webRoleIds: Array.isArray(data.webRoleIds) ? (data.webRoleIds as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [],
    webRoleNames: Array.isArray(data.webRoleNames) ? (data.webRoleNames as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [],
    status: normalizeStatus(data.status),
  };
}

// ===== Company users (migrado de Functions: system-store) =====

/** Listado simple de usuarios (colecciÃ³n `users` Web). */
webRouter.get("/system/users", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("users").limit(200).get();
    const items = snap.docs
      .map((doc) => {
        const data = (doc.data() ?? {}) as Record<string, unknown>;
        return {
          id: doc.id,
          email: String(data.email ?? ""),
          displayName: String(data.displayName ?? ""),
        };
      })
      .sort((a, b) => (a.displayName || a.email || a.id).localeCompare(b.displayName || b.email || b.id));
    return res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/users GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

function toCompanyRecord(id: string, d: Record<string, unknown>): Record<string, unknown> {
  const country = getCountryByCode(d.countryCode);
  const allowed = country ? (filterAllowedCurrenciesByCountry(country.code, d.allowedCurrencies) ?? []) : [];
  const defaultCurrency = parseCurrencyCode(d.defaultCurrency);
  return {
    id,
    name: String(d.name ?? ""),
    status: normalizeStatus(d.status),
    accountId: normalizeText(d.accountId),
    code: normalizeText(d.code),
    taxId: normalizeText(d.taxId),
    logoUrl: normalizeText(d.logoUrl),
    logoPath: normalizeText(d.logoPath),
    logoLightUrl: normalizeText(d.logoLightUrl),
    logoLightPath: normalizeText(d.logoLightPath),
    logoDarkUrl: normalizeText(d.logoDarkUrl),
    logoDarkPath: normalizeText(d.logoDarkPath),
    countryCode: country?.code,
    allowedCurrencies: allowed,
    defaultCurrency: defaultCurrency && allowed.includes(defaultCurrency) ? defaultCurrency : undefined,
  };
}

/** Lista de empresas del usuario autenticado (por accountId derivado de company-users). */
webRouter.get("/system/companies", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const cuSnap = await db.collection("company-users").where("userId", "==", uid).where("status", "==", "active").get();
    const companyIds = cuSnap.docs.map((doc) => String(doc.data().companyId ?? "")).filter(Boolean);
    const uniqueIds = [...new Set(companyIds)];
    const items: Record<string, unknown>[] = [];
    for (const cid of uniqueIds) {
      const compSnap = await db.collection("companies").doc(cid).get();
      if (compSnap.exists) items.push(toCompanyRecord(compSnap.id, compSnap.data() as Record<string, unknown>));
    }
    items.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/companies GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

/** CompaÃ±Ã­a por ID (vÃ­a Admin SDK, evita security rules del cliente). */
webRouter.get("/system/companies/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("companies").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    const company = toCompanyRecord(snap.id, data as Record<string, unknown>);
    return res.status(200).json(company);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/companies/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

webRouter.get("/system/currencies", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const items = getCurrenciesCatalog().map((row) => ({
      code: row.code,
      name: row.name,
      abbreviation: row.abbreviation,
      symbol: row.symbol,
      decimalDigits: row.decimalDigits,
      formatLocale: row.formatLocale,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/currencies GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

webRouter.get("/system/units-of-measure", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const items = getUnitsOfMeasureCatalog().map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      abbreviation: row.abbreviation,
      sunatCode: row.sunatCode,
      sunatName: row.sunatName,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/units-of-measure GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

/** Cuenta por ID (vÃ­a Admin SDK). */
webRouter.get("/system/accounts/:id", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("accounts").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    return res.status(200).json({
      id: snap.id,
      name: String(data.name ?? ""),
      status: data.status === "inactive" ? "inactive" : "active",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/accounts/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

/** SuscripciÃ³n por accountId (doc id = accountId). */
webRouter.get("/system/subscriptions/:accountId", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("subscriptions").doc(req.params.accountId).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    return res.status(200).json({
      id: snap.id,
      accountId: String(data.accountId ?? snap.id),
      planId: String(data.planId ?? "default"),
      status: data.status === "inactive" ? "inactive" : "active",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/subscriptions/:accountId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

/** Usuarios de empresa para sesiÃ³n: lookup por Auth UID. */
webRouter.get("/system/company-users/me", async (req, res) => {
  try {
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    logWebApi("company-users:me:start", { uidPrefix: uid ? `${uid.slice(0, 6)}â€¦` : "(missing)" });
    if (!uid) return res.status(401).json({ error: "unauthenticated" });
    const db = getWebFirestore();
    const snap = await db.collection("company-users").where("userId", "==", uid).get();
    logWebApi("company-users:me:query", { empty: snap.empty, count: snap.size });
    const items = snap.docs.map((doc) => toCompanyUserRecord(doc)).sort((a: any, b: any) => String(a.companyId).localeCompare(String(b.companyId)));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/company-users/me GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

/** Usuarios de empresa por companyId (requiere pertenencia a esa empresa). */
webRouter.get("/system/company-users", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("company-users").where("companyId", "==", companyId).get();
    const items = snap.docs
      .map((doc) => toCompanyUserRecord(doc))
      .sort((a: any, b: any) => String(a.user ?? a.userDisplayName ?? a.userEmail ?? a.userId).localeCompare(String(b.user ?? b.userDisplayName ?? b.userEmail ?? b.userId)));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/company-users GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : msg === "companyId_required" ? 400 : 500).json({ error: msg });
  }
});

/** Upsert de usuario de empresa (id determinÃ­stico companyId_userId). */
webRouter.post("/system/company-users", async (req, res) => {
  try {
    const { uid, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const userId = String(req.body?.userId ?? "").trim();
    if (!userId) return res.status(400).json({ error: "userId_required" });

    const companyUserDocId = `${companyId}_${userId}`;
    const now = new Date();
    const patch: Record<string, unknown> = {
      companyId,
      userId,
      user: normalizeText(req.body?.user),
      usersDocId: normalizeText(req.body?.usersDocId),
      userEmail: normalizeText(req.body?.userEmail)?.toLowerCase(),
      userDisplayName: normalizeText(req.body?.userDisplayName),
      webRoleIds: Array.isArray(req.body?.webRoleIds) ? req.body.webRoleIds.map((x: unknown) => String(x).trim()).filter(Boolean) : [],
      webRoleNames: Array.isArray(req.body?.webRoleNames) ? req.body.webRoleNames.map((x: unknown) => String(x).trim()).filter(Boolean) : [],
      status: normalizeStatus(req.body?.status),
      updateAt: now,
      updateBy: normalizeText((req as any)?.auth?.email) || uid,
    };

    await db.collection("company-users").doc(companyUserDocId).set(patch, { merge: true });
    return res.status(200).json({ id: companyUserDocId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/company-users POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : msg === "companyId_required" ? 400 : 500).json({ error: msg });
  }
});

webRouter.put("/system/company-users/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    const db = getWebFirestore();
    const current = await db.collection("company-users").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });

    const companyId = String(current.data()?.companyId ?? "").trim();
    if (!companyId) return res.status(412).json({ error: "missing_companyId" });
    await requireCompanyScope({ ...(req as any), query: { ...(req as any).query, companyId } });

    const now = new Date();
    const safePatch: Record<string, unknown> = { ...(req.body ?? {}) };
    delete (safePatch as any).uid;
    delete (safePatch as any).companyId;
    delete (safePatch as any).accountId;
    delete (safePatch as any).createdAt;
    delete (safePatch as any).createAt;
    if ("userEmail" in safePatch && safePatch.userEmail != null) {
      safePatch.userEmail = String(safePatch.userEmail).trim().toLowerCase();
    }
    if ("status" in safePatch) safePatch.status = normalizeStatus((safePatch as any).status);
    safePatch.updateAt = now;
    safePatch.updateBy = normalizeText((req as any)?.auth?.email) || String((req as any)?.auth?.uid ?? "").trim() || "web";

    await db.collection("company-users").doc(id).update(safePatch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/company-users/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/system/company-users/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id_required" });
    const db = getWebFirestore();
    const current = await db.collection("company-users").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });

    const companyId = String(current.data()?.companyId ?? "").trim();
    if (!companyId) return res.status(412).json({ error: "missing_companyId" });
    await requireCompanyScope({ ...(req as any), query: { ...(req as any).query, companyId } });

    await db.collection("company-users").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/company-users/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Document types (master) =====

function normalizeDocumentTypeScope(req: any): { country: string; type: "identity" | "billing" } | null {
  const country = parseDocumentTypeCountry(req.query?.country);
  const type = parseDocumentTypeCategory(req.query?.type);
  if (!type) return null;
  return { country, type };
}

function normalizeUbigeoScope(req: any): { country: "PE" } | null {
  const country = parseUbigeoCountry(req.query?.country ?? req.body?.country ?? "PE");
  if (!country) return null;
  return { country };
}

function resolveUbigeo(rawCode: unknown, rawCountry: unknown): { code: string; name: string } | null {
  const row = getUbigeoByCodeAndCountry(rawCode, rawCountry);
  if (!row) return null;
  return { code: row.code, name: row.name };
}

function resolveIdentityDocumentType(idRaw: unknown, req: any): { id: string; name: string } | null {
  const id = String(idRaw ?? "").trim();
  if (!id) return null;
  const country = parseDocumentTypeCountry(req.body?.documentTypeCountry ?? req.query?.documentTypeCountry ?? "PE");
  const type = parseDocumentTypeCategory(req.body?.documentTypeCategory ?? req.query?.documentTypeCategory ?? "identity");
  if (type !== "identity") return null;
  const match = getDocumentTypeByIdAndScope(id, country, "identity");
  if (!match) return null;
  return { id: match.id, name: match.name };
}

webRouter.get("/master/document-types", async (req, res) => {
  try {
    await requireCompanyScope(req as any);
    const scope = normalizeDocumentTypeScope(req as any);
    if (!scope) return res.status(400).json({ error: "type_required", message: "Debe enviar type: identity o billing." });
    const items = getDocumentTypesByCountryAndType(scope.country, scope.type);
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-types GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/master/document-types/:id", async (req, res) => {
  return res.status(410).json({ error: "gone", message: "Operacion no disponible para catalogo fijo." });
});

webRouter.post("/master/document-types", async (req, res) => {
  return res.status(410).json({ error: "gone", message: "Operacion no disponible para catalogo fijo." });
});

webRouter.put("/master/document-types/:id", async (req, res) => {
  return res.status(410).json({ error: "gone", message: "Operacion no disponible para catalogo fijo." });
});

webRouter.delete("/master/document-types/:id", async (req, res) => {
  return res.status(410).json({ error: "gone", message: "Operacion no disponible para catalogo fijo." });
});

webRouter.get("/master/ubigeos", async (req, res) => {
  try {
    await requireCompanyScope(req as any);
    const scope = normalizeUbigeoScope(req as any);
    if (!scope) {
      return res.status(400).json({ error: "country_required", message: "Debe enviar country válido (ej. PE)." });
    }
    const items = getUbigeosByCountry(scope.country).map((item) => ({
      code: item.code,
      name: item.name,
      country: item.country,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/ubigeos GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Clients (master) =====

const CLIENT_STATUSES = ["active", "inactive", "suspended"];
const PAYMENT_CONDITIONS = ["transfer", "cash", "credit", "check"];
const LOCATION_TYPES = ["warehouse", "store", "office", "plant"];

function toClientRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const status = CLIENT_STATUSES.includes(String(d.status ?? "")) ? d.status : "active";
  return {
    id: doc.id,
    code: normalizeText(d.code),
    businessName: normalizeText(d.businessName),
    commercialName: normalizeText(d.commercialName),
    documentTypeId: normalizeText(d.documentTypeId),
    documentType: normalizeText(d.documentType),
    documentNumber: normalizeText(d.documentNumber),
    contact: d.contact && typeof d.contact === "object" ? {
      contactName: normalizeText((d.contact as any).contactName),
      email: normalizeText((d.contact as any).email),
      phone: normalizeText((d.contact as any).phone),
    } : { contactName: "", email: "", phone: "" },
    billing: d.billing && typeof d.billing === "object" ? {
      creditDays: Number((d.billing as any).creditDays) || 0,
      creditLimit: Number((d.billing as any).creditLimit) || 0,
      currency: normalizeText((d.billing as any).currency) || "PEN",
      paymentCondition: PAYMENT_CONDITIONS.includes(String((d.billing as any).paymentCondition)) ? (d.billing as any).paymentCondition : "transfer",
    } : { creditDays: 0, creditLimit: 0, currency: "PEN", paymentCondition: "transfer" },
    logistics: d.logistics && typeof d.logistics === "object" ? {
      priority: Number((d.logistics as any).priority) || 0,
      requiresAppointment: (d.logistics as any).requiresAppointment === true,
      defaultServiceTimeMin: Number((d.logistics as any).defaultServiceTimeMin) || 0,
    } : { priority: 0, requiresAppointment: false, defaultServiceTimeMin: 0 },
    status,
    fiscal: d.fiscal && typeof d.fiscal === "object" ? {
      address: normalizeText((d.fiscal as any).address),
      district: normalizeText((d.fiscal as any).district),
      city: normalizeText((d.fiscal as any).city),
      country: normalizeText((d.fiscal as any).country) || "PE",
      ubigeo: normalizeText((d.fiscal as any).ubigeo),
    } : undefined,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/master/clients", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("clients")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toClientRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/master/clients/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("clients").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toClientRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/master/clients", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const businessName = normalizeText(body.businessName);
    if (!businessName) return res.status(400).json({ error: "businessName_required" });
    const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
    if (!documentType) {
      return res.status(400).json({ error: "documentTypeId_invalid" });
    }
    const code = normalizeText(body.code);
    const contact = body.contact && typeof body.contact === "object" ? (body.contact as any) : {};
    const billing = body.billing && typeof body.billing === "object" ? (body.billing as any) : {};
    const logistics = body.logistics && typeof body.logistics === "object" ? (body.logistics as any) : {};
    const fiscal = body.fiscal && typeof body.fiscal === "object" ? (body.fiscal as any) : null;
    const doc = {
      companyId,
      accountId,
      code,
      businessName,
      commercialName: normalizeText(body.commercialName),
      documentTypeId: documentType.id,
      documentType: documentType.name,
      documentNumber: normalizeText(body.documentNumber),
      contact: {
        contactName: normalizeText(contact.contactName),
        email: normalizeText(contact.email),
        phone: normalizeText(contact.phone),
      },
      billing: {
        creditDays: Number(billing.creditDays) || 0,
        creditLimit: Number(billing.creditLimit) || 0,
        currency: normalizeText(billing.currency) || "PEN",
        paymentCondition: PAYMENT_CONDITIONS.includes(String(billing.paymentCondition)) ? billing.paymentCondition : "transfer",
      },
      logistics: {
        priority: Number(logistics.priority) || 0,
        requiresAppointment: logistics.requiresAppointment === true,
        defaultServiceTimeMin: Number(logistics.defaultServiceTimeMin) || 0,
      },
      status: CLIENT_STATUSES.includes(String(body.status)) ? body.status : "active",
      ...(fiscal ? {
        fiscal: {
          address: normalizeText(fiscal.address),
          district: normalizeText(fiscal.district),
          city: normalizeText(fiscal.city),
          country: normalizeText(fiscal.country) || "PE",
          ubigeo: normalizeText(fiscal.ubigeo),
        },
      } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const docRef = db.collection("clients").doc();
    await docRef.set(doc);
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "clients-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/master/clients/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("clients").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    const safeFields = ["code", "businessName", "commercialName", "documentNumber", "status"];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.documentTypeId !== undefined) {
      const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
      if (!documentType) {
        return res.status(400).json({ error: "documentTypeId_invalid" });
      }
      patch.documentTypeId = documentType.id;
      patch.documentType = documentType.name;
    }
    if (body.contact !== undefined && body.contact !== null) {
      const c = body.contact as any;
      patch.contact = {
        contactName: normalizeText(c?.contactName),
        email: normalizeText(c?.email),
        phone: normalizeText(c?.phone),
      };
    }
    if (body.billing !== undefined && body.billing !== null) {
      const b = body.billing as any;
      patch.billing = {
        creditDays: Number(b?.creditDays) || 0,
        creditLimit: Number(b?.creditLimit) || 0,
        currency: normalizeText(b?.currency) || "PEN",
        paymentCondition: PAYMENT_CONDITIONS.includes(String(b?.paymentCondition)) ? b.paymentCondition : "transfer",
      };
    }
    if (body.logistics !== undefined && body.logistics !== null) {
      const l = body.logistics as any;
      patch.logistics = {
        priority: Number(l?.priority) || 0,
        requiresAppointment: l?.requiresAppointment === true,
        defaultServiceTimeMin: Number(l?.defaultServiceTimeMin) || 0,
      };
    }
    if (body.fiscal !== undefined) {
      if (body.fiscal === null) {
        patch.fiscal = null;
      } else {
        const f = body.fiscal as any;
        patch.fiscal = {
          address: normalizeText(f?.address),
          district: normalizeText(f?.district),
          city: normalizeText(f?.city),
          country: normalizeText(f?.country) || "PE",
          ubigeo: normalizeText(f?.ubigeo),
        };
      }
    }
    await db.collection("clients").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/master/clients/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("clients").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("clients").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "clients-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Document Sequences (master) =====

function toDocumentSequenceRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    sequence: String(d.sequence ?? ""),
    documentType: String(d.documentType ?? "invoice"),
    currentNumber: Number(d.currentNumber ?? 0),
    maxNumber: Number(d.maxNumber ?? 0),
    active: d.active === true,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/master/document-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    let snap = await db
      .collection("document-sequences")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    let items = snap.docs.map(toDocumentSequenceRecord);

    const filterDocType = String(req.headers["x-filter-documenttype"] ?? "").trim();
    const filterActive = String(req.headers["x-filter-active"] ?? "").trim();
    if (filterDocType) items = items.filter((i) => i.documentType === filterDocType);
    if (filterActive === "true") items = items.filter((i) => i.active === true);

    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/master/document-sequences/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("document-sequences").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    return res.status(200).json(toDocumentSequenceRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/master/document-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const sequence = String(body.sequence ?? "").trim();
    const documentType = String(body.documentType ?? "invoice").trim();
    if (!sequence || !/^[A-Za-z0-9]+$/.test(sequence)) {
      return res.status(400).json({ error: "invalid_sequence", message: "La serie solo puede contener letras y nÃºmeros." });
    }
    if (!["invoice", "packing-list", "dispatch-guide", "credit-note", "debit-note", "receipt"].includes(documentType)) {
      return res.status(400).json({ error: "invalid_document_type" });
    }
    const currentNumber = Number(body.currentNumber ?? 1);
    const maxNumber = Number(body.maxNumber ?? 99999999);
    if (!Number.isInteger(currentNumber) || currentNumber < 1) {
      return res.status(400).json({ error: "invalid_current_number" });
    }
    if (!Number.isInteger(maxNumber) || maxNumber <= currentNumber) {
      return res.status(400).json({ error: "invalid_max_number" });
    }
    const snap = await db
      .collection("document-sequences")
      .where("companyId", "==", companyId)
      .where("sequence", "==", sequence)
      .where("documentType", "==", documentType)
      .limit(1)
      .get();
    if (!snap.empty) return res.status(409).json({ error: "duplicate", message: "Ya existe una secuencia con esa serie y tipo." });

    const docRef = db.collection("document-sequences").doc();
    await docRef.set({
      companyId, accountId,
      sequence, documentType,
      currentNumber, maxNumber,
      active: body.active === true,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/master/document-sequences/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("document-sequences").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };

    if (body.sequence !== undefined) {
      const s = String(body.sequence).trim();
      if (!s || !/^[A-Za-z0-9]+$/.test(s)) return res.status(400).json({ error: "invalid_sequence" });
      patch.sequence = s;
    }
    if (body.documentType !== undefined) {
      const dt = String(body.documentType).trim();
      if (!["invoice", "packing-list", "dispatch-guide", "credit-note", "debit-note", "receipt"].includes(dt)) {
        return res.status(400).json({ error: "invalid_document_type" });
      }
      patch.documentType = dt;
    }
    if (body.currentNumber !== undefined || body.maxNumber !== undefined) {
      const cur = Number(body.currentNumber ?? currentData.currentNumber);
      const max = Number(body.maxNumber ?? currentData.maxNumber);
      if (!Number.isInteger(cur) || cur < 1) return res.status(400).json({ error: "invalid_current_number" });
      if (!Number.isInteger(max) || max <= cur) return res.status(400).json({ error: "invalid_max_number" });
      if (body.currentNumber !== undefined) patch.currentNumber = cur;
      if (body.maxNumber !== undefined) patch.maxNumber = max;
    }
    if (body.active !== undefined) patch.active = body.active === true;

    await db.collection("document-sequences").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/master/document-sequences/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("document-sequences").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("document-sequences").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/master/document-sequences/:id/next-number", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const ref = db.collection("document-sequences").doc(id);
    const next = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("sequence_not_found");
      const data = snap.data() as Record<string, unknown>;
      if (String(data.companyId ?? "").trim() !== companyId) throw new Error("forbidden");
      const current = Number(data.currentNumber) || 0;
      const max = Number(data.maxNumber) || 99999999;
      if (current >= max) throw new Error("sequence_exhausted");
      const nextNum = current + 1;
      tx.update(ref, { currentNumber: nextNum });
      return nextNum;
    });
    return res.status(200).json({ currentNumber: next });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences/:id/next-number GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "sequence_not_found" ? 412 : msg === "forbidden" ? 403 : msg === "sequence_exhausted" ? 409 : 500).json({ error: msg });
  }
});

webRouter.get("/master/document-sequences/:id/generate", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const ref = db.collection("document-sequences").doc(id);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("sequence_not_found");
      const data = snap.data() as Record<string, unknown>;
      if (String(data.companyId ?? "").trim() !== companyId) throw new Error("forbidden");
      const sequence = String(data.sequence ?? id);
      const current = Number(data.currentNumber) || 0;
      const max = Number(data.maxNumber) || 99999999;
      if (current >= max) throw new Error("sequence_exhausted");
      const nextNum = current + 1;
      tx.update(ref, { currentNumber: nextNum });
      return {
        documentNo: `${sequence}-${String(nextNum).padStart(8, "0")}`,
        assignedNumber: nextNum,
      };
    });

    return res.status(200).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/document-sequences/:id/generate GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "sequence_not_found" ? 412 : msg === "forbidden" ? 403 : msg === "sequence_exhausted" ? 409 : 500).json({ error: msg });
  }
});

// ===== Positions (human-resource) =====

function toPositionRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    name: normalizeText(d.name),
    active: d.active !== false,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/human-resource/positions", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("positions")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toPositionRecord);
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/positions GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/positions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("positions").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toPositionRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/positions/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/positions", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = normalizeText(body.name);
    if (!name) return res.status(400).json({ error: "name_required" });
    const code = normalizeText(body.code);
    const docRef = db.collection("positions").doc();
    await docRef.set({
      companyId, accountId,
      name,
      code,
      active: body.active !== false,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/positions POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/positions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("positions").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("positions").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/positions/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/positions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("positions").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("positions").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/positions/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Employees (human-resource) =====

const EMPLOYEE_STATUSES = ["active", "inactive", "suspended"];
const SALARY_TYPES = ["monthly", "weekly", "daily"];

function toEmployeeRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const status = EMPLOYEE_STATUSES.includes(String(d.status)) ? d.status : "active";
  return {
    id: doc.id,
    code: normalizeText(d.code),
    firstName: normalizeText(d.firstName),
    lastName: normalizeText(d.lastName),
    documentNo: normalizeText(d.documentNo),
    documentTypeId: normalizeText(d.documentTypeId),
    documentType: normalizeText(d.documentType),
    phone: normalizeText(d.phone) || normalizeText(d.phoneNo),
    email: normalizeText(d.email),
    positionId: normalizeText(d.positionId),
    position: normalizeText(d.position),
    hireDate: normalizeText(d.hireDate),
    status,
    payroll: d.payroll && typeof d.payroll === "object" ? {
      salaryType: SALARY_TYPES.includes(String((d.payroll as any).salaryType)) ? (d.payroll as any).salaryType : "monthly",
      baseSalary: Number((d.payroll as any).baseSalary) || 0,
      workingDays: Math.max(1, Number((d.payroll as any).workingDays) || 26),
      currency: normalizeText((d.payroll as any).currency) || "PEN",
    } : { salaryType: "monthly", baseSalary: 0, workingDays: 26, currency: "PEN" },
    benefits: d.benefits && typeof d.benefits === "object" ? {
      cts: (d.benefits as any).cts === true,
      gratification: (d.benefits as any).gratification === true,
      vacationDays: Number((d.benefits as any).vacationDays) || 0,
    } : { cts: true, gratification: true, vacationDays: 30 },
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/human-resource/employees", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("employees")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toEmployeeRecord);
    items.sort((a: any, b: any) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/employees GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/employees/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("employees").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toEmployeeRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/employees/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/employees", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!body.firstName?.trim() || !body.lastName?.trim()) {
      return res.status(400).json({ error: "names_required" });
    }
    const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
    if (!documentType) {
      return res.status(400).json({ error: "documentTypeId_invalid" });
    }
    const payroll = body.payroll && typeof body.payroll === "object" ? body.payroll : {};
    const benefits = body.benefits && typeof body.benefits === "object" ? body.benefits : {};
    const docRef = db.collection("employees").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      firstName: String(body.firstName ?? "").trim(),
      lastName: String(body.lastName ?? "").trim(),
      documentNo: normalizeText(body.documentNo),
      documentTypeId: documentType.id,
      documentType: documentType.name,
      phone: normalizeText(body.phone),
      email: normalizeText(body.email),
      positionId: normalizeText(body.positionId),
      position: normalizeText(body.position),
      hireDate: normalizeText(body.hireDate),
      status: EMPLOYEE_STATUSES.includes(String(body.status)) ? body.status : "active",
      payroll: {
        salaryType: SALARY_TYPES.includes(String(payroll.salaryType)) ? payroll.salaryType : "monthly",
        baseSalary: Number(payroll.baseSalary) || 0,
        workingDays: Math.max(1, Number(payroll.workingDays) || 26),
        currency: normalizeText(payroll.currency) || "PEN",
      },
      benefits: {
        cts: benefits.cts === true,
        gratification: benefits.gratification === true,
        vacationDays: Number(benefits.vacationDays) || 0,
      },
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "employees-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/employees POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/employees/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("employees").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    const simple = ["code", "firstName", "lastName", "documentNo", "phone", "email", "positionId", "position", "hireDate"];
    for (const f of simple) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.documentTypeId !== undefined) {
      const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
      if (!documentType) {
        return res.status(400).json({ error: "documentTypeId_invalid" });
      }
      patch.documentTypeId = documentType.id;
      patch.documentType = documentType.name;
    }
    if (body.status !== undefined) patch.status = EMPLOYEE_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.payroll !== undefined && body.payroll !== null) {
      const p = body.payroll as any;
      patch.payroll = {
        salaryType: SALARY_TYPES.includes(String(p?.salaryType)) ? p.salaryType : "monthly",
        baseSalary: Number(p?.baseSalary) || 0,
        workingDays: Math.max(1, Number(p?.workingDays) || 26),
        currency: normalizeText(p?.currency) || "PEN",
      };
    }
    if (body.benefits !== undefined && body.benefits !== null) {
      const b = body.benefits as any;
      patch.benefits = {
        cts: b?.cts === true,
        gratification: b?.gratification === true,
        vacationDays: Number(b?.vacationDays) || 0,
      };
    }
    await db.collection("employees").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/employees/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/employees/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("employees").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("employees").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "employees-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/employees/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Resources (human-resource) =====

const RESOURCE_ENGAGEMENT_TYPES = ["sporadic", "permanent", "contract"];
const RESOURCE_STATUSES = ["active", "inactive", "suspended"];
const RESOURCE_COST_TYPES = ["per_trip", "per_hour", "per_day", "fixed"];

function toResourceRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    firstName: normalizeText(d.firstName),
    lastName: normalizeText(d.lastName),
    documentNo: normalizeText(d.documentNo),
    documentTypeId: normalizeText(d.documentTypeId),
    documentType: normalizeText(d.documentType),
    phone: normalizeText(d.phone) || normalizeText(d.phoneNo),
    email: normalizeText(d.email),
    positionId: normalizeText(d.positionId),
    position: normalizeText(d.position),
    hireDate: normalizeText(d.hireDate),
    engagementType: RESOURCE_ENGAGEMENT_TYPES.includes(String(d.engagementType)) ? d.engagementType : "sporadic",
    status: RESOURCE_STATUSES.includes(String(d.status)) ? d.status : "active",
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

function toResourceCostRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    type: RESOURCE_COST_TYPES.includes(String(d.type)) ? d.type : "per_trip",
    amount: Number(d.amount) || 0,
    currency: normalizeText(d.currency) || "PEN",
    effectiveFrom: normalizeText(d.effectiveFrom),
    active: d.active !== false,
  };
}

webRouter.get("/human-resource/resources", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("resources").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toResourceRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("resources").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toResourceRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/resources", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!body.firstName?.trim() || !body.lastName?.trim()) return res.status(400).json({ error: "names_required" });
    const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
    if (!documentType) {
      return res.status(400).json({ error: "documentTypeId_invalid" });
    }
    const docRef = db.collection("resources").doc();
    await docRef.set({ companyId, accountId, code: normalizeText(body.code), firstName: String(body.firstName ?? "").trim(), lastName: String(body.lastName ?? "").trim(), documentNo: normalizeText(body.documentNo), documentTypeId: documentType.id, documentType: documentType.name, phone: normalizeText(body.phone), email: normalizeText(body.email), positionId: normalizeText(body.positionId), position: normalizeText(body.position), hireDate: normalizeText(body.hireDate), engagementType: RESOURCE_ENGAGEMENT_TYPES.includes(String(body.engagementType)) ? body.engagementType : "sporadic", status: RESOURCE_STATUSES.includes(String(body.status)) ? body.status : "active", createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("resources").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "firstName", "lastName", "documentNo", "phone", "email", "positionId", "position", "hireDate"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.documentTypeId !== undefined) {
      const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
      if (!documentType) {
        return res.status(400).json({ error: "documentTypeId_invalid" });
      }
      patch.documentTypeId = documentType.id;
      patch.documentType = documentType.name;
    }
    if (body.engagementType !== undefined) patch.engagementType = RESOURCE_ENGAGEMENT_TYPES.includes(String(body.engagementType)) ? body.engagementType : currentData.engagementType;
    if (body.status !== undefined) patch.status = RESOURCE_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("resources").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("resources").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("resources").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:resourceId/costs", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("resources").doc(resourceId).collection("resource-costs").get();
    res.status(200).json({ items: snap.docs.map(toResourceCostRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toResourceCostRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/resources/:resourceId/costs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("resources").doc(resourceId).collection("resource-costs").doc();
    await docRef.set({ companyId, accountId, code: normalizeText(body.code), type: RESOURCE_COST_TYPES.includes(String(body.type)) ? body.type : "per_trip", amount: Number(body.amount) || 0, currency: normalizeText(body.currency) || "PEN", effectiveFrom: normalizeText(body.effectiveFrom), active: body.active !== false, createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.type !== undefined) patch.type = RESOURCE_COST_TYPES.includes(String(body.type)) ? body.type : "per_trip";
    if (body.amount !== undefined) patch.amount = Number(body.amount) || 0;
    if (body.currency !== undefined) patch.currency = normalizeText(body.currency);
    if (body.effectiveFrom !== undefined) patch.effectiveFrom = normalizeText(body.effectiveFrom);
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Orders (logistic) =====

const ORDER_STATUSES = ["pending", "confirmed", "in_progress", "delivered", "cancelled"];

function toOrderRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const loc = d.location && typeof d.location === "object" ? d.location : d.geoPoint ? { latitude: (d.geoPoint as any).latitude, longitude: (d.geoPoint as any).longitude } : { latitude: 0, longitude: 0 };
  return {
    id: doc.id,
    code: normalizeText(d.code),
    clientId: normalizeText(d.clientId),
    client: normalizeText(d.client),
    deliveryAddress: normalizeText(d.deliveryAddress),
    location: { latitude: Number(loc.latitude) || 0, longitude: Number(loc.longitude) || 0 },
    deliveryWindowStart: normalizeText(d.deliveryWindowStart) || "08:00",
    deliveryWindowEnd: normalizeText(d.deliveryWindowEnd) || "12:00",
    weight: Number(d.weight) || 0,
    volume: Number(d.volume) || 0,
    status: ORDER_STATUSES.includes(String(d.status)) ? d.status : "pending",
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/logistic/orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("orders").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toOrderRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/logistic/orders GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/logistic/orders/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("orders").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toOrderRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/logistic/orders/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/logistic/orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const loc = body.location && typeof body.location === "object" ? body.location : {};
    const docRef = db.collection("orders").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      clientId: normalizeText(body.clientId),
      client: normalizeText(body.client),
      deliveryAddress: normalizeText(body.deliveryAddress),
      location: { latitude: Number(loc.latitude) || 0, longitude: Number(loc.longitude) || 0 },
      deliveryWindowStart: normalizeText(body.deliveryWindowStart) || "08:00",
      deliveryWindowEnd: normalizeText(body.deliveryWindowEnd) || "12:00",
      weight: Number(body.weight) || 0,
      volume: Number(body.volume) || 0,
      status: ORDER_STATUSES.includes(String(body.status)) ? body.status : "pending",
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "orders-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/logistic/orders POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/logistic/orders/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("orders").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    const simple = ["code", "clientId", "client", "deliveryAddress", "deliveryWindowStart", "deliveryWindowEnd", "weight", "volume"];
    for (const f of simple) {
      if (body[f] !== undefined) {
        patch[f] = f === "weight" || f === "volume" ? Number(body[f]) || 0 : normalizeText(body[f]);
      }
    }
    if (body.location !== undefined && body.location !== null) {
      const l = body.location as any;
      patch.location = { latitude: Number(l?.latitude) || 0, longitude: Number(l?.longitude) || 0 };
    }
    if (body.status !== undefined) patch.status = ORDER_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("orders").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/logistic/orders/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/logistic/orders/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("orders").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("orders").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "orders-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/logistic/orders/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Transport Services (transport) =====

const SERVICE_TYPE_CATEGORIES = ["distribution", "express", "dedicated"];
const CALCULATION_TYPES = ["fixed", "zone", "per_km", "per_weight", "per_volume", "percentage", "formula"];

function toTransportServiceRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    name: normalizeText(d.name),
    description: normalizeText(d.description),
    category: SERVICE_TYPE_CATEGORIES.includes(String(d.category)) ? d.category : "distribution",
    defaultServiceTimeMin: Number(d.defaultServiceTimeMin) || 0,
    calculationType: CALCULATION_TYPES.includes(String(d.calculationType)) ? d.calculationType : "fixed",
    requiresAppointment: d.requiresAppointment === true,
    allowConsolidation: d.allowConsolidation !== false,
    active: d.active !== false,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/transport/transport-services", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("transport-services").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toTransportServiceRecord), total: snap.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-services GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/transport-services/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("transport-services").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toTransportServiceRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-services/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/transport-services", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = normalizeText(body.name);
    if (!name) return res.status(400).json({ error: "name_required" });
    const docRef = db.collection("transport-services").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      name,
      description: normalizeText(body.description),
      category: SERVICE_TYPE_CATEGORIES.includes(String(body.category)) ? body.category : "distribution",
      defaultServiceTimeMin: Number(body.defaultServiceTimeMin) || 0,
      calculationType: CALCULATION_TYPES.includes(String(body.calculationType)) ? body.calculationType : "fixed",
      requiresAppointment: body.requiresAppointment === true,
      allowConsolidation: body.allowConsolidation !== false,
      active: body.active !== false,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-services POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/transport-services/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("transport-services").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.description !== undefined) patch.description = normalizeText(body.description);
    if (body.category !== undefined) patch.category = SERVICE_TYPE_CATEGORIES.includes(String(body.category)) ? body.category : currentData.category;
    if (body.defaultServiceTimeMin !== undefined) patch.defaultServiceTimeMin = Number(body.defaultServiceTimeMin) || 0;
    if (body.calculationType !== undefined) patch.calculationType = CALCULATION_TYPES.includes(String(body.calculationType)) ? body.calculationType : currentData.calculationType;
    if (body.requiresAppointment !== undefined) patch.requiresAppointment = body.requiresAppointment === true;
    if (body.allowConsolidation !== undefined) patch.allowConsolidation = body.allowConsolidation !== false;
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("transport-services").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-services/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/transport-services/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("transport-services").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("transport-services").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-services/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Charge Types (transport) =====

const CHARGE_TYPE_KINDS = ["charge", "cost"];
const CHARGE_TYPE_SOURCES = ["", "service", "employee", "resource", "employee_resource"];
const CHARGE_TYPE_CATEGORIES = ["base", "extra", "variable"];

function toChargeTypeRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    type: CHARGE_TYPE_KINDS.includes(String(d.type)) ? d.type : "charge",
    source: CHARGE_TYPE_SOURCES.includes(String(d.source)) ? d.source : "",
    name: normalizeText(d.name),
    category: CHARGE_TYPE_CATEGORIES.includes(String(d.category)) ? d.category : "extra",
    active: d.active !== false,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/transport/charge-types", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("charge-types").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toChargeTypeRecord), total: snap.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/charge-types GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/charge-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("charge-types").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toChargeTypeRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/charge-types/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/charge-types", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = normalizeText(body.name);
    if (!name) return res.status(400).json({ error: "name_required" });
    const docRef = db.collection("charge-types").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      type: CHARGE_TYPE_KINDS.includes(String(body.type)) ? body.type : "charge",
      source: CHARGE_TYPE_SOURCES.includes(String(body.source)) ? body.source : "",
      name,
      category: CHARGE_TYPE_CATEGORIES.includes(String(body.category)) ? body.category : "extra",
      active: body.active !== false,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/charge-types POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/charge-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("charge-types").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.type !== undefined) patch.type = CHARGE_TYPE_KINDS.includes(String(body.type)) ? body.type : currentData.type;
    if (body.source !== undefined) patch.source = CHARGE_TYPE_SOURCES.includes(String(body.source)) ? body.source : currentData.source;
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.category !== undefined) patch.category = CHARGE_TYPE_CATEGORIES.includes(String(body.category)) ? body.category : currentData.category;
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("charge-types").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/charge-types/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/charge-types/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("charge-types").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("charge-types").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/charge-types/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Transport Contracts (transport) =====

const CONTRACT_STATUSES = ["draft", "active", "expired", "cancelled"];
const BILLING_CYCLES = ["monthly", "weekly", "per_trip"];
const RATE_RULE_TYPES = ["base", "extra_charge", "penalty", "discount"];
const CALCULATION_TYPES_CONTRACTS = ["fixed", "zone", "per_km", "per_weight", "per_volume", "percentage", "formula"];

function toContractRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    clientId: normalizeText(d.clientId),
    client: normalizeText(d.client),
    contractCode: normalizeText(d.contractCode),
    description: normalizeText(d.description),
    currency: normalizeText(d.currency) || "PEN",
    validFrom: normalizeText(d.validFrom),
    validTo: normalizeText(d.validTo),
    billingCycle: BILLING_CYCLES.includes(String(d.billingCycle)) ? d.billingCycle : "monthly",
    paymentTermsDays: Number(d.paymentTermsDays) || 30,
    status: CONTRACT_STATUSES.includes(String(d.status)) ? d.status : "draft",
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

function toRateRuleRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const conditions = d.conditions && typeof d.conditions === "object" ? d.conditions as Record<string, unknown> : {};
  const calculation = d.calculation && typeof d.calculation === "object" ? d.calculation as Record<string, unknown> : {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    name: normalizeText(d.name),
    active: d.active === true,
    priority: Number(d.priority) || 0,
    ruleType: RATE_RULE_TYPES.includes(String(d.ruleType)) ? d.ruleType : "base",
    calculationType: CALCULATION_TYPES_CONTRACTS.includes(String(d.calculationType)) ? d.calculationType : "fixed",
    transportServiceId: normalizeText(d.transportServiceId),
    transportService: normalizeText(d.transportService),
    vehicleType: normalizeText(d.vehicleType),
    conditions: {
      originZone: conditions.originZone != null ? String(conditions.originZone) : null,
      destinationZone: conditions.destinationZone != null ? String(conditions.destinationZone) : null,
      minWeight: conditions.minWeight != null ? Number(conditions.minWeight) : null,
      maxWeight: conditions.maxWeight != null ? Number(conditions.maxWeight) : null,
      minDistanceKm: conditions.minDistanceKm != null ? Number(conditions.minDistanceKm) : null,
      maxDistanceKm: conditions.maxDistanceKm != null ? Number(conditions.maxDistanceKm) : null,
      priorityLevel: conditions.priorityLevel != null ? String(conditions.priorityLevel) : null,
      dayOfWeek: conditions.dayOfWeek != null ? String(conditions.dayOfWeek) : null,
    },
    calculation: {
      basePrice: calculation.basePrice != null ? Number(calculation.basePrice) : null,
      pricePerKm: calculation.pricePerKm != null ? Number(calculation.pricePerKm) : null,
      pricePerTon: calculation.pricePerTon != null ? Number(calculation.pricePerTon) : null,
      pricePerM3: calculation.pricePerM3 != null ? Number(calculation.pricePerM3) : null,
      percentage: calculation.percentage != null ? Number(calculation.percentage) : null,
    },
    stackable: d.stackable === true,
    validFrom: normalizeText(d.validFrom),
    validTo: normalizeText(d.validTo),
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/transport/transport-contracts", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("transport-contracts").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toContractRecord), total: snap.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/transport-contracts/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("transport-contracts").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toContractRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/transport-contracts", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("transport-contracts").doc();
    await docRef.set({
      companyId, accountId,
      clientId: normalizeText(body.clientId),
      client: normalizeText(body.client),
      contractCode: normalizeText(body.contractCode),
      description: normalizeText(body.description),
      currency: normalizeText(body.currency) || "PEN",
      validFrom: normalizeText(body.validFrom),
      validTo: normalizeText(body.validTo),
      billingCycle: BILLING_CYCLES.includes(String(body.billingCycle)) ? body.billingCycle : "monthly",
      paymentTermsDays: Number(body.paymentTermsDays) || 30,
      status: CONTRACT_STATUSES.includes(String(body.status)) ? body.status : "draft",
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/transport-contracts/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("transport-contracts").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    const simple = ["clientId", "client", "contractCode", "description", "currency", "validFrom", "validTo"];
    for (const f of simple) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.billingCycle !== undefined) patch.billingCycle = BILLING_CYCLES.includes(String(body.billingCycle)) ? body.billingCycle : currentData.billingCycle;
    if (body.paymentTermsDays !== undefined) patch.paymentTermsDays = Number(body.paymentTermsDays) || 30;
    if (body.status !== undefined) patch.status = CONTRACT_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("transport-contracts").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/transport-contracts/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("transport-contracts").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("transport-contracts").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Transport Rate Rules (subcollection) =====

webRouter.get("/transport/transport-contracts/:contractId/transport-rate-rules", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { contractId } = req.params;
    const contractSnap = await db.collection("transport-contracts").doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: "contract_not_found" });
    if (String(contractSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").get();
    const items = snap.docs.map(toRateRuleRecord).sort((a, b) => Number(a.priority) - Number(b.priority));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id/transport-rate-rules GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/transport-contracts/:contractId/transport-rate-rules/:ruleId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { contractId, ruleId } = req.params;
    const contractSnap = await db.collection("transport-contracts").doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: "contract_not_found" });
    if (String(contractSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").doc(ruleId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toRateRuleRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id/transport-rate-rules/:ruleId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/transport-contracts/:contractId/transport-rate-rules", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { contractId } = req.params;
    const contractSnap = await db.collection("transport-contracts").doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: "contract_not_found" });
    if (String(contractSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      name: normalizeText(body.name),
      active: body.active === true,
      priority: Number(body.priority) || 0,
      ruleType: RATE_RULE_TYPES.includes(String(body.ruleType)) ? body.ruleType : "base",
      calculationType: CALCULATION_TYPES_CONTRACTS.includes(String(body.calculationType)) ? body.calculationType : "fixed",
      transportServiceId: normalizeText(body.transportServiceId),
      transportService: normalizeText(body.transportService),
      vehicleType: normalizeText(body.vehicleType),
      conditions: body.conditions ?? {},
      calculation: body.calculation ?? {},
      stackable: body.stackable === true,
      validFrom: normalizeText(body.validFrom),
      validTo: normalizeText(body.validTo),
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id/transport-rate-rules POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/transport-contracts/:contractId/transport-rate-rules/:ruleId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { contractId, ruleId } = req.params;
    const contractSnap = await db.collection("transport-contracts").doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: "contract_not_found" });
    if (String(contractSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").doc(ruleId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.active !== undefined) patch.active = body.active === true;
    if (body.priority !== undefined) patch.priority = Number(body.priority) || 0;
    if (body.ruleType !== undefined) patch.ruleType = RATE_RULE_TYPES.includes(String(body.ruleType)) ? body.ruleType : "base";
    if (body.calculationType !== undefined) patch.calculationType = CALCULATION_TYPES_CONTRACTS.includes(String(body.calculationType)) ? body.calculationType : "fixed";
    if (body.transportServiceId !== undefined) patch.transportServiceId = normalizeText(body.transportServiceId);
    if (body.transportService !== undefined) patch.transportService = normalizeText(body.transportService);
    if (body.vehicleType !== undefined) patch.vehicleType = normalizeText(body.vehicleType);
    if (body.conditions !== undefined) patch.conditions = body.conditions;
    if (body.calculation !== undefined) patch.calculation = body.calculation;
    if (body.stackable !== undefined) patch.stackable = body.stackable === true;
    if (body.validFrom !== undefined) patch.validFrom = normalizeText(body.validFrom);
    if (body.validTo !== undefined) patch.validTo = normalizeText(body.validTo);
    await db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").doc(ruleId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id/transport-rate-rules/:ruleId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/transport-contracts/:contractId/transport-rate-rules/:ruleId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { contractId, ruleId } = req.params;
    const contractSnap = await db.collection("transport-contracts").doc(contractId).get();
    if (!contractSnap.exists) return res.status(404).json({ error: "contract_not_found" });
    if (String(contractSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("transport-contracts").doc(contractId).collection("transport-rate-rules").doc(ruleId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/transport-contracts/:id/transport-rate-rules/:ruleId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Vehicles (transport) =====

const VEHICLE_STATUSES = ["available", "assigned", "inactive"];

function toVehicleRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    plate: normalizeText(d.plate),
    type: normalizeText(d.type),
    brand: normalizeText(d.brand),
    model: normalizeText(d.model),
    capacityKg: Number(d.capacityKg) || 0,
    status: VEHICLE_STATUSES.includes(String(d.status)) ? d.status : "available",
    currentTripId: normalizeText(d.currentTripId),
    active: d.active === true,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ""),
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? ""),
  };
}

webRouter.get("/transport/vehicles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("vehicles").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toVehicleRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/vehicles GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/vehicles/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("vehicles").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toVehicleRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/vehicles/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/vehicles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("vehicles").doc();
    await docRef.set({
      companyId, accountId,
      plate: normalizeText(body.plate),
      type: normalizeText(body.type),
      brand: normalizeText(body.brand),
      model: normalizeText(body.model),
      capacityKg: Number(body.capacityKg) || 0,
      status: VEHICLE_STATUSES.includes(String(body.status)) ? body.status : "available",
      currentTripId: normalizeText(body.currentTripId) || "",
      active: body.active !== false,
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "vehicles-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/vehicles POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/vehicles/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("vehicles").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["plate", "type", "brand", "model"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.capacityKg !== undefined) patch.capacityKg = Number(body.capacityKg) || 0;
    if (body.status !== undefined) patch.status = VEHICLE_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.currentTripId !== undefined) patch.currentTripId = normalizeText(body.currentTripId) || "";
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("vehicles").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/vehicles/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/vehicles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("vehicles").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("vehicles").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "vehicles-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/vehicles/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Client Locations (subcollection) =====

function toLocationRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const type = LOCATION_TYPES.includes(String(d.type)) ? d.type : "warehouse";
  const geo = d.geo && typeof d.geo === "object" ? d.geo : d.geoPoint ? { latitude: (d.geoPoint as any).latitude, longitude: (d.geoPoint as any).longitude } : { latitude: 0, longitude: 0 };
  return {
    id: doc.id,
    name: normalizeText(d.name),
    type,
    address: normalizeText(d.address),
    district: normalizeText(d.district),
    city: normalizeText(d.city),
    country: normalizeText(d.country),
    geo,
    deliveryWindow: d.deliveryWindow && typeof d.deliveryWindow === "object" ? {
      start: normalizeText((d.deliveryWindow as any).start) || "08:00",
      end: normalizeText((d.deliveryWindow as any).end) || "16:00",
    } : { start: "08:00", end: "16:00" },
    serviceTimeMin: Number(d.serviceTimeMin) || 0,
    active: d.active === true,
  };
}

webRouter.get("/master/clients/:clientId/locations", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { clientId } = req.params;
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (!clientSnap.exists) return res.status(404).json({ error: "client_not_found" });
    if (String(clientSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const snap = await db.collection("clients").doc(clientId).collection("locations").get();
    const items = snap.docs.map(toLocationRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id/locations GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/master/clients/:clientId/locations/:locationId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { clientId, locationId } = req.params;
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (!clientSnap.exists) return res.status(404).json({ error: "client_not_found" });
    if (String(clientSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const snap = await db.collection("clients").doc(clientId).collection("locations").doc(locationId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toLocationRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id/locations/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/master/clients/:clientId/locations", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { clientId } = req.params;
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (!clientSnap.exists) return res.status(404).json({ error: "client_not_found" });
    if (String(clientSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const now = new Date();
    const body = req.body ?? {};
    const geo = body.geo && typeof body.geo === "object" ? body.geo : {};
    const deliveryWindow = body.deliveryWindow && typeof body.deliveryWindow === "object" ? body.deliveryWindow : {};
    const doc = {
      companyId,
      accountId,
      name: normalizeText(body.name),
      type: LOCATION_TYPES.includes(String(body.type)) ? body.type : "warehouse",
      address: normalizeText(body.address),
      district: normalizeText(body.district),
      city: normalizeText(body.city),
      country: normalizeText(body.country),
      geo: {
        latitude: Number(geo.latitude) || 0,
        longitude: Number(geo.longitude) || 0,
      },
      deliveryWindow: {
        start: normalizeText(deliveryWindow.start) || "08:00",
        end: normalizeText(deliveryWindow.end) || "16:00",
      },
      serviceTimeMin: Number(body.serviceTimeMin) || 0,
      active: body.active === true,
    };
    const docRef = db.collection("clients").doc(clientId).collection("locations").doc();
    await docRef.set(doc);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id/locations POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/master/clients/:clientId/locations/:locationId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { clientId, locationId } = req.params;
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (!clientSnap.exists) return res.status(404).json({ error: "client_not_found" });
    if (String(clientSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const current = await db.collection("clients").doc(clientId).collection("locations").doc(locationId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    const safeFields = ["name", "type", "address", "district", "city", "country", "serviceTimeMin", "active"];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = f === "active" ? body[f] === true : normalizeText(body[f]);
    }
    if (body.type !== undefined) patch.type = LOCATION_TYPES.includes(String(body.type)) ? body.type : "warehouse";
    if (body.geo !== undefined && body.geo !== null) {
      const geo = body.geo as any;
      patch.geo = { latitude: Number(geo.latitude) || 0, longitude: Number(geo.longitude) || 0 };
    }
    if (body.deliveryWindow !== undefined && body.deliveryWindow !== null) {
      const dw = body.deliveryWindow as any;
      patch.deliveryWindow = {
        start: normalizeText(dw?.start) || "08:00",
        end: normalizeText(dw?.end) || "16:00",
      };
    }
    await db.collection("clients").doc(clientId).collection("locations").doc(locationId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id/locations/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/master/clients/:clientId/locations/:locationId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { clientId, locationId } = req.params;
    const clientSnap = await db.collection("clients").doc(clientId).get();
    if (!clientSnap.exists) return res.status(404).json({ error: "client_not_found" });
    if (String(clientSnap.data()?.companyId ?? "").trim() !== companyId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("clients").doc(clientId).collection("locations").doc(locationId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/master/clients/:id/locations/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/system/web-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const items = await listMergedSequences(getWebFirestore(), "web", accountId, companyId);
    logWebApi("web-sequences GET ok", { companyId, itemCount: items.length });
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const item = await getMergedSequenceById(getWebFirestore(), "web", accountId, req.params.id, companyId);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-sequences", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const out = await createCustomSequence(getWebFirestore(), "web", accountId, req.body ?? {}, companyId);
    res.status(201).json({ ok: true, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.put("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await updateCustomSequence(getWebFirestore(), "web", accountId, req.params.id, req.body ?? {}, companyId);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.delete("/system/web-sequences/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await deleteCustomSequence(getWebFirestore(), "web", accountId, req.params.id, companyId);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-sequences/generate-code", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const code = await generateSequenceCode(
      getWebFirestore(),
      "web",
      accountId,
      String(req.body?.entity ?? ""),
      String(req.body?.currentCode ?? ""),
      companyId
    );
    res.status(200).json({ code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-sequences/generate-code POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : sequenceHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-roles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const items = await listMergedWebRoles(getWebFirestore(), accountId, companyId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.get("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const item = await getMergedWebRoleById(getWebFirestore(), accountId, companyId, req.params.id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.post("/system/web-roles", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const { id } = await createWebCustomRole(getWebFirestore(), accountId, companyId, {
      ...(req.body ?? {}),
      createBy: "web",
      updateBy: "web",
    });
    res.status(201).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.put("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await updateWebCustomRole(getWebFirestore(), accountId, companyId, req.params.id, {
      ...(req.body ?? {}),
      updateBy: "web",
    });
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});

webRouter.delete("/system/web-roles/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    await deleteWebCustomRole(getWebFirestore(), accountId, companyId, req.params.id);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/system/web-roles DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    res.status(msg === "forbidden" ? 403 : roleHttpStatus(msg)).json({ error: msg });
  }
});


webRouter.get("/human-resource/resources", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("resources").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    res.status(200).json({ items: snap.docs.map(toResourceRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("resources").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toResourceRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/resources", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!body.firstName?.trim() || !body.lastName?.trim()) return res.status(400).json({ error: "names_required" });
    const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
    if (!documentType) {
      return res.status(400).json({ error: "documentTypeId_invalid" });
    }
    const docRef = db.collection("resources").doc();
    await docRef.set({ companyId, accountId, code: normalizeText(body.code), firstName: String(body.firstName ?? "").trim(), lastName: String(body.lastName ?? "").trim(), documentNo: normalizeText(body.documentNo), documentTypeId: documentType.id, documentType: documentType.name, phone: normalizeText(body.phone), email: normalizeText(body.email), positionId: normalizeText(body.positionId), position: normalizeText(body.position), hireDate: normalizeText(body.hireDate), engagementType: RESOURCE_ENGAGEMENT_TYPES.includes(String(body.engagementType)) ? body.engagementType : "sporadic", status: RESOURCE_STATUSES.includes(String(body.status)) ? body.status : "active", createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("resources").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "firstName", "lastName", "documentNo", "phone", "email", "positionId", "position", "hireDate"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.documentTypeId !== undefined) {
      const documentType = resolveIdentityDocumentType(body.documentTypeId, req as any);
      if (!documentType) {
        return res.status(400).json({ error: "documentTypeId_invalid" });
      }
      patch.documentTypeId = documentType.id;
      patch.documentType = documentType.name;
    }
    if (body.engagementType !== undefined) patch.engagementType = RESOURCE_ENGAGEMENT_TYPES.includes(String(body.engagementType)) ? body.engagementType : currentData.engagementType;
    if (body.status !== undefined) patch.status = RESOURCE_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("resources").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/resources/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("resources").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("resources").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:resourceId/costs", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("resources").doc(resourceId).collection("resource-costs").get();
    res.status(200).json({ items: snap.docs.map(toResourceCostRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toResourceCostRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/human-resource/resources/:resourceId/costs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("resources").doc(resourceId).collection("resource-costs").doc();
    await docRef.set({ companyId, accountId, code: normalizeText(body.code), type: RESOURCE_COST_TYPES.includes(String(body.type)) ? body.type : "per_trip", amount: Number(body.amount) || 0, currency: normalizeText(body.currency) || "PEN", effectiveFrom: normalizeText(body.effectiveFrom), active: body.active !== false, createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.type !== undefined) patch.type = RESOURCE_COST_TYPES.includes(String(body.type)) ? body.type : "per_trip";
    if (body.amount !== undefined) patch.amount = Number(body.amount) || 0;
    if (body.currency !== undefined) patch.currency = normalizeText(body.currency);
    if (body.effectiveFrom !== undefined) patch.effectiveFrom = normalizeText(body.effectiveFrom);
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/human-resource/resources/:resourceId/costs/:costId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { resourceId, costId } = req.params;
    const resourceSnap = await db.collection("resources").doc(resourceId).get();
    if (!resourceSnap.exists) return res.status(404).json({ error: "resource_not_found" });
    if (String(resourceSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("resources").doc(resourceId).collection("resource-costs").doc(costId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/human-resource/resources/:id/costs/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Drivers (transport) =====

const DRIVER_RELATIONSHIP_TYPES = ["employee", "resource"];
const DRIVER_STATUSES = ["available", "assigned", "inactive"];

function toDriverRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const relationshipType = DRIVER_RELATIONSHIP_TYPES.includes(String(d.relationshipType)) ? d.relationshipType : "resource";
  const status = DRIVER_STATUSES.includes(String(d.status)) ? d.status : "available";
  return {
    id: doc.id,
    firstName: normalizeText(d.firstName),
    lastName: normalizeText(d.lastName),
    documentNo: normalizeText(d.documentNo),
    documentTypeId: normalizeText(d.documentTypeId),
    documentType: normalizeText(d.documentType),
    phoneNo: normalizeText(d.phoneNo),
    licenseNo: normalizeText(d.licenseNo),
    licenseCategory: normalizeText(d.licenseCategory),
    licenseExpiration: normalizeText(d.licenseExpiration),
    relationshipType,
    employeeId: d.employeeId != null && String(d.employeeId).trim() !== "" ? String(d.employeeId) : null,
    resourceId: d.resourceId != null && String(d.resourceId).trim() !== "" ? String(d.resourceId) : null,
    status,
    currentTripId: normalizeText(d.currentTripId),
  };
}

webRouter.get("/transport/drivers", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("drivers").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toDriverRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/drivers GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/drivers/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("drivers").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toDriverRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/drivers/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/drivers", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("drivers").doc();
    await docRef.set({
      companyId, accountId,
      firstName: String(body.firstName ?? "").trim(),
      lastName: String(body.lastName ?? "").trim(),
      documentNo: normalizeText(body.documentNo),
      documentTypeId: normalizeText(body.documentTypeId),
      documentType: normalizeText(body.documentType),
      phoneNo: normalizeText(body.phoneNo),
      licenseNo: normalizeText(body.licenseNo),
      licenseCategory: normalizeText(body.licenseCategory),
      licenseExpiration: normalizeText(body.licenseExpiration) || null,
      relationshipType: DRIVER_RELATIONSHIP_TYPES.includes(String(body.relationshipType)) ? body.relationshipType : "employee",
      employeeId: body.employeeId?.trim() ? body.employeeId.trim() : null,
      resourceId: body.resourceId?.trim() ? body.resourceId.trim() : null,
      status: DRIVER_STATUSES.includes(String(body.status)) ? body.status : "available",
      currentTripId: normalizeText(body.currentTripId) || "",
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "drivers-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/drivers POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/drivers/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("drivers").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    const simple = ["firstName", "lastName", "documentNo", "documentTypeId", "documentType", "phoneNo", "licenseNo", "licenseCategory", "licenseExpiration"];
    for (const f of simple) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.relationshipType !== undefined) patch.relationshipType = DRIVER_RELATIONSHIP_TYPES.includes(String(body.relationshipType)) ? body.relationshipType : currentData.relationshipType;
    if (body.employeeId !== undefined) patch.employeeId = body.employeeId?.trim() ? body.employeeId.trim() : null;
    if (body.resourceId !== undefined) patch.resourceId = body.resourceId?.trim() ? body.resourceId.trim() : null;
    if (body.status !== undefined) patch.status = DRIVER_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.currentTripId !== undefined) patch.currentTripId = normalizeText(body.currentTripId) || "";
    await db.collection("drivers").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/drivers/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/drivers/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("drivers").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("drivers").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "drivers-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/drivers/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Plans (transport) =====

const PLAN_STATUSES = ["draft", "confirmed", "in_progress", "completed", "cancelled"];

function toPlanRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    date: normalizeText(d.date),
    zone: normalizeText(d.zone),
    vehicleType: normalizeText(d.vehicleType),
    orderIds: Array.isArray(d.orderIds) ? d.orderIds.map((x) => String(x)).filter(Boolean) : [],
    status: PLAN_STATUSES.includes(String(d.status)) ? d.status : "draft",
  };
}

webRouter.get("/transport/plans", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-plans").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toPlanRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/plans GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/plans/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-plans").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toPlanRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/plans/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/plans", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("trip-plans").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      date: normalizeText(body.date),
      zone: normalizeText(body.zone),
      vehicleType: normalizeText(body.vehicleType),
      orderIds: Array.isArray(body.orderIds) ? body.orderIds : [],
      status: PLAN_STATUSES.includes(String(body.status)) ? body.status : "draft",
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/plans POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/plans/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-plans").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.date !== undefined) patch.date = normalizeText(body.date);
    if (body.zone !== undefined) patch.zone = normalizeText(body.zone);
    if (body.vehicleType !== undefined) patch.vehicleType = normalizeText(body.vehicleType);
    if (body.orderIds !== undefined) patch.orderIds = Array.isArray(body.orderIds) ? body.orderIds : currentData.orderIds ?? [];
    if (body.status !== undefined) patch.status = PLAN_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("trip-plans").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/plans/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/plans/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-plans").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-plans").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/plans/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Routes (transport) =====

function toRouteRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    name: normalizeText(d.name),
    code: normalizeText(d.code),
    planId: normalizeText(d.planId),
    planCode: normalizeText(d.planCode),
    totalEstimatedKm: Number(d.totalEstimatedKm) || 0,
    totalEstimatedHours: Number(d.totalEstimatedHours) || 0,
    active: d.active === true,
  };
}

webRouter.get("/transport/routes", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-routes").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toRouteRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/routes/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-routes").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toRouteRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/routes", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("trip-routes").doc();
    await docRef.set({
      companyId, accountId,
      name: normalizeText(body.name),
      code: normalizeText(body.code),
      planId: normalizeText(body.planId),
      planCode: normalizeText(body.planCode),
      totalEstimatedKm: Number(body.totalEstimatedKm) || 0,
      totalEstimatedHours: Number(body.totalEstimatedHours) || 0,
      active: body.active !== false,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/routes/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-routes").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.planId !== undefined) patch.planId = normalizeText(body.planId);
    if (body.planCode !== undefined) patch.planCode = normalizeText(body.planCode);
    if (body.totalEstimatedKm !== undefined) patch.totalEstimatedKm = Number(body.totalEstimatedKm) || 0;
    if (body.totalEstimatedHours !== undefined) patch.totalEstimatedHours = Number(body.totalEstimatedHours) || 0;
    if (body.active !== undefined) patch.active = body.active === true;
    await db.collection("trip-routes").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/routes/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-routes").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-routes").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trips (transport) =====

const TRIP_STATUSES = ["scheduled", "in_progress", "completed", "cancelled", "suspended"];

function toTripRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    routeId: normalizeText(d.routeId),
    route: normalizeText(d.route) || normalizeText(d.routeCode),
    isExternalRoute: d.isExternalRoute === true,
    transportServiceId: normalizeText(d.transportServiceId),
    transportService: normalizeText(d.transportService),
    clientId: normalizeText(d.clientId),
    client: normalizeText(d.client),
    vehicleId: normalizeText(d.vehicleId),
    vehicle: normalizeText(d.vehicle),
    transportGuide: normalizeText(d.transportGuide),
    status: TRIP_STATUSES.includes(String(d.status)) ? d.status : "scheduled",
    scheduledStart: String(d.scheduledStart ?? ""),
  };
}

function toTripStopRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const toStr = (v: unknown): string => v != null && v !== "" ? String(v) : "";
  return {
    id: doc.id,
    code: normalizeText(d.code),
    order: Number(d.order) || 0,
    type: ["origin", "pickup", "delivery", "checkpoint", "rest"].includes(String(d.type)) ? d.type : "checkpoint",
    name: normalizeText(d.name),
    externalDocument: normalizeText(d.externalDocument),
    districtId: normalizeText(d.districtId),
    districtName: normalizeText(d.districtName),
    observations: normalizeText(d.observations),
    lat: Number(d.lat) || 0,
    lng: Number(d.lng) || 0,
    status: ["pending", "arrived", "completed", "skipped"].includes(String(d.status)) ? d.status : "pending",
    plannedArrival: toStr(d.plannedArrival),
    actualArrival: d.actualArrival != null && d.actualArrival !== "" ? toStr(d.actualArrival) : null,
    actualDeparture: d.actualDeparture != null && d.actualDeparture !== "" ? toStr(d.actualDeparture) : null,
  };
}

webRouter.get("/transport/trips", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trips").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toTripRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/trips/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trips").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toTripRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/trips", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("trips").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      routeId: normalizeText(body.routeId),
      route: normalizeText(body.route),
      isExternalRoute: body.isExternalRoute === true,
      transportServiceId: normalizeText(body.transportServiceId),
      transportService: normalizeText(body.transportService),
      clientId: normalizeText(body.clientId),
      client: normalizeText(body.client),
      vehicleId: normalizeText(body.vehicleId),
      vehicle: normalizeText(body.vehicle),
      transportGuide: normalizeText(body.transportGuide),
      status: TRIP_STATUSES.includes(String(body.status)) ? body.status : "scheduled",
      scheduledStart: normalizeText(body.scheduledStart) || null,
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "trips-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/trips/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trips").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "routeId", "route", "transportServiceId", "transportService", "clientId", "client", "vehicleId", "vehicle", "transportGuide", "scheduledStart"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.isExternalRoute !== undefined) patch.isExternalRoute = body.isExternalRoute === true;
    if (body.status !== undefined) patch.status = TRIP_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    await db.collection("trips").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/trips/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trips").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trips").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "trips-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trip Stops (subcollection) =====

webRouter.get("/transport/trips/:tripId/trip-stops", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("trips").doc(tripId).collection("tripStops").get();
    const items = snap.docs.map(toTripStopRecord).sort((a, b) => Number(a.order) - Number(b.order));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/trip-stops GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/trips/:tripId/trip-stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId, stopId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("trips").doc(tripId).collection("tripStops").doc(stopId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toTripStopRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/trip-stops/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/trips/:tripId/trip-stops", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const ubigeo = resolveUbigeo(body.districtId, "PE");
    if (!ubigeo) {
      return res.status(422).json({ error: "districtId_invalid", message: "districtId no existe en catálogo ubigeos." });
    }
    const stopId = String(body.id ?? "").trim().toLowerCase().replace(/\s+/g, "-") || `stop-${Date.now()}`;
    await db.collection("trips").doc(tripId).collection("tripStops").doc(stopId).set({
      companyId, accountId,
      code: normalizeText(body.code),
      order: Number(body.order) || 0,
      type: ["origin", "pickup", "delivery", "checkpoint", "rest"].includes(String(body.type)) ? body.type : "checkpoint",
      name: normalizeText(body.name),
      externalDocument: normalizeText(body.externalDocument),
      districtId: ubigeo.code,
      districtName: ubigeo.name,
      observations: normalizeText(body.observations),
      lat: Number(body.lat) || 0,
      lng: Number(body.lng) || 0,
      status: ["pending", "arrived", "completed", "skipped"].includes(String(body.status)) ? body.status : "pending",
      plannedArrival: normalizeText(body.plannedArrival) || null,
      actualArrival: body.actualArrival?.trim() || null,
      actualDeparture: body.actualDeparture?.trim() || null,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: stopId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/trip-stops POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/trips/:tripId/trip-stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId, stopId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("trips").doc(tripId).collection("tripStops").doc(stopId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.order !== undefined) patch.order = Number(body.order) || 0;
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.type !== undefined) patch.type = ["origin", "pickup", "delivery", "checkpoint", "rest"].includes(String(body.type)) ? body.type : current.data()?.type;
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.externalDocument !== undefined) patch.externalDocument = normalizeText(body.externalDocument);
    if (body.districtId !== undefined) {
      const ubigeo = resolveUbigeo(body.districtId, "PE");
      if (!ubigeo) {
        return res.status(422).json({ error: "districtId_invalid", message: "districtId no existe en catálogo ubigeos." });
      }
      patch.districtId = ubigeo.code;
      patch.districtName = ubigeo.name;
    } else if (body.districtName !== undefined) {
      patch.districtName = normalizeText(body.districtName);
    }
    if (body.observations !== undefined) patch.observations = normalizeText(body.observations);
    if (body.lat !== undefined) patch.lat = Number(body.lat) || 0;
    if (body.lng !== undefined) patch.lng = Number(body.lng) || 0;
    if (body.status !== undefined) patch.status = ["pending", "arrived", "completed", "skipped"].includes(String(body.status)) ? body.status : current.data()?.status;
    if (body.plannedArrival !== undefined) patch.plannedArrival = body.plannedArrival?.trim() || null;
    if (body.actualArrival !== undefined) patch.actualArrival = body.actualArrival?.trim() || null;
    if (body.actualDeparture !== undefined) patch.actualDeparture = body.actualDeparture?.trim() || null;
    await db.collection("trips").doc(tripId).collection("tripStops").doc(stopId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/trip-stops/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/trips/:tripId/trip-stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId, stopId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trips").doc(tripId).collection("tripStops").doc(stopId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/trip-stops/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trip Costs (top-level, filtered by tripId) =====

const TRIP_COST_STATUSES = ["open", "settled", "cancelled"];
const TRIP_COST_SOURCES = ["manual", "assignment", "contract"];
const TRIP_COST_TYPES = ["employee_payment", "vehicle_rental", "fuel", "toll", "parking", "penalty", "bonus", "other"];
const TRIP_COST_ENTITIES = ["trip", "employee", "resource", "vehicle"];

function toTripCostRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    displayName: normalizeText(d.displayName),
    tripId: normalizeText(d.tripId),
    entity: TRIP_COST_ENTITIES.includes(String(d.entity)) ? d.entity : "trip",
    entityId: normalizeText(d.entityId),
    chargeTypeId: normalizeText(d.chargeTypeId),
    chargeType: normalizeText(d.chargeType),
    type: TRIP_COST_TYPES.includes(String(d.type)) ? d.type : "employee_payment",
    source: TRIP_COST_SOURCES.includes(String(d.source)) ? d.source : "manual",
    amount: Number(d.amount) || 0,
    currency: normalizeText(d.currency) || "PEN",
    status: TRIP_COST_STATUSES.includes(String(d.status)) ? d.status : "open",
    settlementId: d.settlementId != null && String(d.settlementId).trim() !== "" ? String(d.settlementId) : null,
    sync: d.sync && typeof d.sync === "object" ? (d.sync as Record<string, unknown>) : null,
  };
}

webRouter.get("/transport/trip-costs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const tripId = String(req.query.tripId ?? "").trim();
    if (!tripId) return res.status(400).json({ error: "tripId_required" });
    const snap = await db
      .collection("trip-costs")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .where("tripId", "==", tripId)
      .get();
    res.status(200).json({ items: snap.docs.map(toTripCostRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-costs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/trip-costs/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-costs").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toTripCostRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-costs/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/trip-costs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!String(body.tripId ?? "").trim()) return res.status(400).json({ error: "tripId_required" });
    const docRef = db.collection("trip-costs").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      displayName: normalizeText(body.displayName),
      tripId: normalizeText(body.tripId),
      entity: TRIP_COST_ENTITIES.includes(String(body.entity)) ? body.entity : "trip",
      entityId: normalizeText(body.entityId),
      chargeTypeId: normalizeText(body.chargeTypeId),
      chargeType: normalizeText(body.chargeType),
      type: TRIP_COST_TYPES.includes(String(body.type)) ? body.type : "employee_payment",
      source: TRIP_COST_SOURCES.includes(String(body.source)) ? body.source : "manual",
      amount: Number(body.amount) || 0,
      currency: normalizeText(body.currency) || "PEN",
      status: TRIP_COST_STATUSES.includes(String(body.status)) ? body.status : "open",
      settlementId: body.settlementId?.trim() ? body.settlementId.trim() : null,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-costs POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/trip-costs/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-costs").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "displayName", "tripId", "entityId", "chargeTypeId", "chargeType", "currency"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.entity !== undefined) patch.entity = TRIP_COST_ENTITIES.includes(String(body.entity)) ? body.entity : currentData.entity;
    if (body.type !== undefined) patch.type = TRIP_COST_TYPES.includes(String(body.type)) ? body.type : currentData.type;
    if (body.source !== undefined) patch.source = TRIP_COST_SOURCES.includes(String(body.source)) ? body.source : currentData.source;
    if (body.amount !== undefined) patch.amount = Number(body.amount) || 0;
    if (body.status !== undefined) patch.status = TRIP_COST_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.settlementId !== undefined) patch.settlementId = body.settlementId?.trim() ? body.settlementId.trim() : null;
    await db.collection("trip-costs").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-costs/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/trip-costs/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-costs").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-costs").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-costs/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trip Charges (top-level, filtered by tripId) =====

const TRIP_CHARGE_STATUSES = ["open", "invoiced", "paid", "cancelled"];
const TRIP_CHARGE_SOURCES = ["manual", "assignment", "contract"];
const TRIP_CHARGE_TYPES = ["freight", "insurance", "loading", "unloading", "storage", "handling", "surcharge", "discount", "other"];
const TRIP_CHARGE_ENTITY_TYPES = ["transportService", "client", "consignee", "employee", "resource"];

function toTripChargeRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    tripId: normalizeText(d.tripId),
    name: normalizeText(d.name),
    chargeTypeId: normalizeText(d.chargeTypeId),
    chargeType: normalizeText(d.chargeType),
    type: TRIP_CHARGE_TYPES.includes(String(d.type)) ? d.type : "freight",
    source: TRIP_CHARGE_SOURCES.includes(String(d.source)) ? d.source : "manual",
    entityType: TRIP_CHARGE_ENTITY_TYPES.includes(String(d.entityType)) ? d.entityType : "transportService",
    entityId: normalizeText(d.entityId),
    amount: Number(d.amount) || 0,
    currency: normalizeText(d.currency) || "PEN",
    status: TRIP_CHARGE_STATUSES.includes(String(d.status)) ? d.status : "open",
    settlementId: d.settlementId != null && String(d.settlementId).trim() !== "" ? String(d.settlementId) : null,
    settlement: normalizeText(d.settlement),
    sync: d.sync && typeof d.sync === "object" ? (d.sync as Record<string, unknown>) : null,
  };
}

webRouter.get("/transport/trip-charges", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const tripId = String(req.query.tripId ?? "").trim();
    if (!tripId) return res.status(400).json({ error: "tripId_required" });
    const snap = await db
      .collection("trip-charges")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .where("tripId", "==", tripId)
      .get();
    res.status(200).json({ items: snap.docs.map(toTripChargeRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-charges GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/trip-charges/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-charges").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toTripChargeRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-charges/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/trip-charges", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!String(body.tripId ?? "").trim()) return res.status(400).json({ error: "tripId_required" });
    const docRef = db.collection("trip-charges").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      tripId: normalizeText(body.tripId),
      name: normalizeText(body.name),
      chargeTypeId: normalizeText(body.chargeTypeId),
      chargeType: normalizeText(body.chargeType),
      type: TRIP_CHARGE_TYPES.includes(String(body.type)) ? body.type : "freight",
      source: TRIP_CHARGE_SOURCES.includes(String(body.source)) ? body.source : "manual",
      entityType: TRIP_CHARGE_ENTITY_TYPES.includes(String(body.entityType)) ? body.entityType : "transportService",
      entityId: normalizeText(body.entityId),
      amount: Number(body.amount) || 0,
      currency: normalizeText(body.currency) || "PEN",
      status: TRIP_CHARGE_STATUSES.includes(String(body.status)) ? body.status : "open",
      settlementId: body.settlementId?.trim() ? body.settlementId.trim() : null,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-charges POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/trip-charges/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-charges").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "tripId", "name", "chargeTypeId", "chargeType", "entityId", "currency"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.type !== undefined) patch.type = TRIP_CHARGE_TYPES.includes(String(body.type)) ? body.type : currentData.type;
    if (body.source !== undefined) patch.source = TRIP_CHARGE_SOURCES.includes(String(body.source)) ? body.source : currentData.source;
    if (body.entityType !== undefined) patch.entityType = TRIP_CHARGE_ENTITY_TYPES.includes(String(body.entityType)) ? body.entityType : currentData.entityType;
    if (body.amount !== undefined) patch.amount = Number(body.amount) || 0;
    if (body.status !== undefined) patch.status = TRIP_CHARGE_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.settlementId !== undefined) patch.settlementId = body.settlementId?.trim() ? body.settlementId.trim() : null;
    await db.collection("trip-charges").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-charges/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/trip-charges/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-charges").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-charges").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-charges/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trip Assignments (top-level, filtered by tripId) =====

const TRIP_ASSIGNMENT_TYPES = ["driver", "helper", "supervisor"];
const TRIP_ASSIGNMENT_ENTITY_TYPES = ["employee", "resource"];
const TRIP_ASSIGNMENT_SCOPE_TYPES = ["trip", "stop", "segment"];

function toTripAssignmentRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const scope = d.scope && typeof d.scope === "object" ? d.scope as Record<string, unknown> : {};
  return {
    id: doc.id,
    code: normalizeText(d.code),
    tripId: normalizeText(d.tripId),
    chargeTypeId: normalizeText(d.chargeTypeId),
    chargeType: normalizeText(d.chargeType),
    type: TRIP_ASSIGNMENT_TYPES.includes(String(d.type)) ? d.type : "driver",
    entityType: TRIP_ASSIGNMENT_ENTITY_TYPES.includes(String(d.entityType)) ? d.entityType : "employee",
    entityId: normalizeText(d.entityId),
    position: normalizeText(d.position),
    positionId: normalizeText(d.positionId),
    displayName: normalizeText(d.displayName),
    scope: {
      type: TRIP_ASSIGNMENT_SCOPE_TYPES.includes(String(scope.type)) ? scope.type : "trip",
      stopId: normalizeText(scope.stopId),
      fromStopId: normalizeText(scope.fromStopId),
      toStopId: normalizeText(scope.toStopId),
      display: normalizeText(scope.display),
    },
  };
}

webRouter.get("/transport/trip-assignments", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const tripId = String(req.query.tripId ?? "").trim();
    if (!tripId) return res.status(400).json({ error: "tripId_required" });
    const snap = await db
      .collection("trip-assignments")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .where("tripId", "==", tripId)
      .get();
    res.status(200).json({ items: snap.docs.map(toTripAssignmentRecord) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-assignments GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/trip-assignments/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("trip-assignments").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toTripAssignmentRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-assignments/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/trip-assignments", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!String(body.tripId ?? "").trim()) return res.status(400).json({ error: "tripId_required" });
    const scope = body.scope && typeof body.scope === "object" ? body.scope as Record<string, unknown> : {};
    const docRef = db.collection("trip-assignments").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      tripId: normalizeText(body.tripId),
      chargeTypeId: normalizeText(body.chargeTypeId),
      chargeType: normalizeText(body.chargeType),
      type: TRIP_ASSIGNMENT_TYPES.includes(String(body.type)) ? body.type : "driver",
      entityType: TRIP_ASSIGNMENT_ENTITY_TYPES.includes(String(body.entityType)) ? body.entityType : "employee",
      entityId: normalizeText(body.entityId),
      position: normalizeText(body.position),
      positionId: normalizeText(body.positionId),
      displayName: normalizeText(body.displayName),
      scope: {
        type: TRIP_ASSIGNMENT_SCOPE_TYPES.includes(String(scope.type)) ? scope.type : "trip",
        stopId: normalizeText(scope.stopId),
        fromStopId: normalizeText(scope.fromStopId),
        toStopId: normalizeText(scope.toStopId),
        display: normalizeText(scope.display),
      },
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-assignments POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/trip-assignments/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-assignments").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    for (const f of ["code", "tripId", "chargeTypeId", "chargeType", "entityId", "position", "positionId", "displayName"]) {
      if (body[f] !== undefined) patch[f] = normalizeText(body[f]);
    }
    if (body.type !== undefined) patch.type = TRIP_ASSIGNMENT_TYPES.includes(String(body.type)) ? body.type : currentData.type;
    if (body.entityType !== undefined) patch.entityType = TRIP_ASSIGNMENT_ENTITY_TYPES.includes(String(body.entityType)) ? body.entityType : currentData.entityType;
    if (body.scope !== undefined && body.scope !== null) {
      const s = body.scope as Record<string, unknown>;
      patch.scope = {
        type: TRIP_ASSIGNMENT_SCOPE_TYPES.includes(String(s.type)) ? s.type : (currentData.scope as Record<string, unknown>)?.type ?? "trip",
        stopId: normalizeText(s.stopId),
        fromStopId: normalizeText(s.fromStopId),
        toStopId: normalizeText(s.toStopId),
        display: normalizeText(s.display),
      };
    }
    await db.collection("trip-assignments").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-assignments/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/trip-assignments/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("trip-assignments").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-assignments").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trip-assignments/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Trip Cascade Counts (for delete preview) =====

webRouter.get("/transport/trips/:tripId/cascade-counts", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { tripId } = req.params;
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) return res.status(404).json({ error: "trip_not_found" });
    if (String(tripSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const [stopsSnap, assignmentsSnap, chargesSnap, costsSnap] = await Promise.all([
      db.collection("trips").doc(tripId).collection("tripStops").get(),
      db.collection("trip-assignments").where("companyId", "==", companyId).where("accountId", "==", accountId).where("tripId", "==", tripId).get(),
      db.collection("trip-charges").where("companyId", "==", companyId).where("accountId", "==", accountId).where("tripId", "==", tripId).get(),
      db.collection("trip-costs").where("companyId", "==", companyId).where("accountId", "==", accountId).where("tripId", "==", tripId).get(),
    ]);
    res.status(200).json({
      tripStops: stopsSnap.size,
      tripAssignments: assignmentsSnap.size,
      tripCharges: chargesSnap.size,
      tripCosts: costsSnap.size,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/trips/:id/cascade-counts GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Settlements (transport) =====

const SETTLEMENT_TYPES = ["payable", "receivable"];
const SETTLEMENT_CATEGORIES = ["customer", "carrier", "provider", "resource"];
const SETTLEMENT_STATUSES = ["draft", "closed"];
const SETTLEMENT_PAYMENT_STATUSES = ["pending", "partial", "paid"];

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function toSettlementRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const entity = d.entity && typeof d.entity === "object" ? d.entity as Record<string, unknown> : {};
  const period = d.period && typeof d.period === "object" ? d.period as Record<string, unknown> : {};
  const totals = d.totals && typeof d.totals === "object" ? d.totals as Record<string, unknown> : {};
  let category = String(d.category ?? "").trim().toLowerCase();
  if (category === "driver") category = "resource";
  if (!SETTLEMENT_CATEGORIES.includes(category)) category = "customer";
  return {
    id: doc.id,
    code: normalizeText(d.code),
    type: SETTLEMENT_TYPES.includes(String(d.type)) ? d.type : "payable",
    category,
    entity: {
      type: normalizeText(entity.type) || "",
      id: normalizeText(entity.id) || "",
      name: normalizeText(entity.name) || "",
    },
    period: {
      start: normalizeText(period.start) || "",
      end: normalizeText(period.end) || "",
      label: normalizeText(period.label) || "",
    },
    totals: {
      grossAmount: num(totals.grossAmount),
      settledAmount: num(totals.settledAmount),
      pendingAmount: num(totals.pendingAmount),
      currency: normalizeText(totals.currency) || "PEN",
    },
    status: SETTLEMENT_STATUSES.includes(String(d.status)) ? d.status : "draft",
    paymentStatus: SETTLEMENT_PAYMENT_STATUSES.includes(String(d.paymentStatus)) ? d.paymentStatus : "pending",
  };
}

function toSettlementItemRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const movement = d.movement && typeof d.movement === "object" ? d.movement as Record<string, unknown> : {};
  const trip = d.trip && typeof d.trip === "object" ? d.trip as Record<string, unknown> : {};
  return {
    id: doc.id,
    movement: {
      type: normalizeText(movement.type) || "",
      id: normalizeText(movement.id) || "",
    },
    trip: {
      id: normalizeText(trip.id) || "",
      code: normalizeText(trip.code) || "",
      route: normalizeText(trip.route) || "",
      scheduledStart: String(trip.scheduledStart ?? "").slice(0, 10),
    },
    chargeType: normalizeText(d.chargeType),
    chargeTypeId: normalizeText(d.chargeTypeId),
    concept: normalizeText(d.concept),
    amount: num(d.amount),
    settledAmount: num(d.settledAmount),
    pendingAmount: num(d.amount),
    currency: normalizeText(d.currency) || "PEN",
  };
}

webRouter.get("/transport/settlements", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("settlements").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map(toSettlementRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/settlements/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("settlements").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toSettlementRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/settlements", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const entity = body.entity && typeof body.entity === "object" ? body.entity as Record<string, unknown> : {};
    const period = body.period && typeof body.period === "object" ? body.period as Record<string, unknown> : {};
    const totals = body.totals && typeof body.totals === "object" ? body.totals as Record<string, unknown> : {};
    let category = String(body.category ?? "").trim().toLowerCase();
    if (category === "driver") category = "resource";
    if (!SETTLEMENT_CATEGORIES.includes(category)) category = "customer";
    const docRef = db.collection("settlements").doc();
    await docRef.set({
      companyId, accountId,
      code: normalizeText(body.code),
      type: SETTLEMENT_TYPES.includes(String(body.type)) ? body.type : "payable",
      category,
      entity: {
        type: normalizeText(entity.type) || "",
        id: normalizeText(entity.id) || "",
        name: normalizeText(entity.name) || "",
      },
      period: {
        start: normalizeText(period.start) || "",
        end: normalizeText(period.end) || "",
        label: normalizeText(period.label) || "",
      },
      totals: {
        grossAmount: num(totals.grossAmount),
        settledAmount: num(totals.settledAmount),
        pendingAmount: num(totals.pendingAmount),
        currency: normalizeText(totals.currency) || "PEN",
      },
      status: SETTLEMENT_STATUSES.includes(String(body.status)) ? body.status : "draft",
      paymentStatus: SETTLEMENT_PAYMENT_STATUSES.includes(String(body.paymentStatus)) ? body.paymentStatus : "pending",
      createdAt: now, updatedAt: now,
    });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "settlements-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/settlements/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("settlements").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const entity = body.entity && typeof body.entity === "object" ? body.entity as Record<string, unknown> : {};
    const period = body.period && typeof body.period === "object" ? body.period as Record<string, unknown> : {};
    const totals = body.totals && typeof body.totals === "object" ? body.totals as Record<string, unknown> : {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.code !== undefined) patch.code = normalizeText(body.code);
    if (body.type !== undefined) patch.type = SETTLEMENT_TYPES.includes(String(body.type)) ? body.type : currentData.type;
    if (body.category !== undefined) {
      let cat = String(body.category).trim().toLowerCase();
      if (cat === "driver") cat = "resource";
      patch.category = SETTLEMENT_CATEGORIES.includes(cat) ? cat : currentData.category;
    }
    if (body.entity !== undefined) patch.entity = { type: normalizeText(entity.type), id: normalizeText(entity.id), name: normalizeText(entity.name) };
    if (body.period !== undefined) patch.period = { start: normalizeText(period.start), end: normalizeText(period.end), label: normalizeText(period.label) };
    if (body.totals !== undefined) patch.totals = { grossAmount: num(totals.grossAmount, currentData.totals?.grossAmount), settledAmount: num(totals.settledAmount, currentData.totals?.settledAmount), pendingAmount: num(totals.pendingAmount, currentData.totals?.pendingAmount), currency: normalizeText(totals.currency) || "PEN" };
    if (body.status !== undefined) patch.status = SETTLEMENT_STATUSES.includes(String(body.status)) ? body.status : currentData.status;
    if (body.paymentStatus !== undefined) patch.paymentStatus = SETTLEMENT_PAYMENT_STATUSES.includes(String(body.paymentStatus)) ? body.paymentStatus : currentData.paymentStatus;
    await db.collection("settlements").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/settlements/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("settlements").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const itemsSnap = await db.collection("settlements").doc(id).collection("items").get();
    const deletes = itemsSnap.docs.map((item) => item.ref.delete());
    await Promise.all(deletes);
    await db.collection("settlements").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "settlements-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Settlement Items (subcollection) =====

webRouter.get("/transport/settlements/:settlementId/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { settlementId } = req.params;
    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) return res.status(404).json({ error: "settlement_not_found" });
    if (String(settlementSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("settlements").doc(settlementId).collection("items").get();
    const items = snap.docs.map(toSettlementItemRecord);
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id/items GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/settlements/:settlementId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { settlementId, itemId } = req.params;
    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) return res.status(404).json({ error: "settlement_not_found" });
    if (String(settlementSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("settlements").doc(settlementId).collection("items").doc(itemId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toSettlementItemRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id/items/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/settlements/:settlementId/items", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { settlementId } = req.params;
    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) return res.status(404).json({ error: "settlement_not_found" });
    if (String(settlementSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const movement = body.movement && typeof body.movement === "object" ? body.movement as Record<string, unknown> : {};
    const trip = body.trip && typeof body.trip === "object" ? body.trip as Record<string, unknown> : {};
    const docRef = db.collection("settlements").doc(settlementId).collection("items").doc();
    await docRef.set({
      companyId, accountId,
      movement: { type: normalizeText(movement.type), id: normalizeText(movement.id) },
      trip: {
        id: normalizeText(trip.id),
        code: normalizeText(trip.code),
        route: normalizeText(trip.route),
        scheduledStart: String(trip.scheduledStart ?? "").slice(0, 10),
      },
      chargeType: normalizeText(body.chargeType),
      chargeTypeId: normalizeText(body.chargeTypeId),
      concept: normalizeText(body.concept),
      amount: num(body.amount),
      settledAmount: num(body.settledAmount),
      pendingAmount: num(body.amount),
      currency: normalizeText(body.currency) || "PEN",
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id/items POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/settlements/:settlementId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { settlementId, itemId } = req.params;
    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) return res.status(404).json({ error: "settlement_not_found" });
    if (String(settlementSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("settlements").doc(settlementId).collection("items").doc(itemId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const movement = body.movement && typeof body.movement === "object" ? body.movement as Record<string, unknown> : {};
    const trip = body.trip && typeof body.trip === "object" ? body.trip as Record<string, unknown> : {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.movement !== undefined) patch.movement = { type: normalizeText(movement.type), id: normalizeText(movement.id) };
    if (body.trip !== undefined) patch.trip = { id: normalizeText(trip.id), code: normalizeText(trip.code), route: normalizeText(trip.route), scheduledStart: String(trip.scheduledStart ?? "").slice(0, 10) };
    if (body.chargeType !== undefined) patch.chargeType = normalizeText(body.chargeType);
    if (body.chargeTypeId !== undefined) patch.chargeTypeId = normalizeText(body.chargeTypeId);
    if (body.concept !== undefined) patch.concept = normalizeText(body.concept);
    if (body.amount !== undefined) patch.amount = num(body.amount);
    if (body.settledAmount !== undefined) patch.settledAmount = num(body.settledAmount);
    if (body.pendingAmount !== undefined) patch.pendingAmount = num(body.pendingAmount);
    if (body.currency !== undefined) patch.currency = normalizeText(body.currency);
    await db.collection("settlements").doc(settlementId).collection("items").doc(itemId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id/items/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/settlements/:settlementId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { settlementId, itemId } = req.params;
    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) return res.status(404).json({ error: "settlement_not_found" });
    if (String(settlementSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("settlements").doc(settlementId).collection("items").doc(itemId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/settlements/:id/items/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

const STOP_TYPES = ["origin", "pickup", "delivery", "checkpoint", "rest"];
const STOP_STATUSES = ["pending", "arrived", "completed", "skipped"];

function toStopRecord(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const sequence = Number(d.sequence ?? d.order) || 0;
  return {
    id: doc.id,
    orderId: normalizeText(d.orderId),
    sequence,
    eta: normalizeText(d.eta),
    arrivalWindowStart: normalizeText(d.arrivalWindowStart),
    arrivalWindowEnd: normalizeText(d.arrivalWindowEnd),
    status: STOP_STATUSES.includes(String(d.status)) ? d.status : "pending",
    order: Number(d.order ?? sequence) || 0,
    type: STOP_TYPES.includes(String(d.type)) ? d.type : "checkpoint",
    name: normalizeText(d.name),
    address: normalizeText(d.address),
    lat: Number(d.lat) || 0,
    lng: Number(d.lng) || 0,
    estimatedArrivalOffsetMinutes: Number(d.estimatedArrivalOffsetMinutes) || 0,
  };
}

webRouter.get("/transport/routes/:routeId/stops", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { routeId } = req.params;
    const routeSnap = await db.collection("trip-routes").doc(routeId).get();
    if (!routeSnap.exists) return res.status(404).json({ error: "route_not_found" });
    if (String(routeSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("trip-routes").doc(routeId).collection("stops").get();
    const items = snap.docs.map(toStopRecord).sort((a, b) => Number(a.sequence) - Number(b.sequence));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id/stops GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/transport/routes/:routeId/stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { routeId, stopId } = req.params;
    const routeSnap = await db.collection("trip-routes").doc(routeId).get();
    if (!routeSnap.exists) return res.status(404).json({ error: "route_not_found" });
    if (String(routeSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("trip-routes").doc(routeId).collection("stops").doc(stopId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toStopRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id/stops/:stopId GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/transport/routes/:routeId/stops", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { routeId } = req.params;
    const routeSnap = await db.collection("trip-routes").doc(routeId).get();
    if (!routeSnap.exists) return res.status(404).json({ error: "route_not_found" });
    if (String(routeSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const stopId = String(body.id ?? "").trim().toLowerCase().replace(/\s+/g, "-") || `stop-${Date.now()}`;
    const sequence = Number(body.sequence ?? body.order) || 0;
    await db.collection("trip-routes").doc(routeId).collection("stops").doc(stopId).set({
      companyId, accountId,
      orderId: normalizeText(body.orderId),
      sequence,
      eta: normalizeText(body.eta) || "",
      arrivalWindowStart: normalizeText(body.arrivalWindowStart) || "",
      arrivalWindowEnd: normalizeText(body.arrivalWindowEnd) || "",
      status: STOP_STATUSES.includes(String(body.status)) ? body.status : "pending",
      order: sequence,
      type: STOP_TYPES.includes(String(body.type)) ? body.type : "checkpoint",
      name: normalizeText(body.name),
      address: normalizeText(body.address),
      lat: Number(body.lat) || 0,
      lng: Number(body.lng) || 0,
      estimatedArrivalOffsetMinutes: Number(body.estimatedArrivalOffsetMinutes) || 0,
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: stopId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id/stops POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/transport/routes/:routeId/stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { routeId, stopId } = req.params;
    const routeSnap = await db.collection("trip-routes").doc(routeId).get();
    if (!routeSnap.exists) return res.status(404).json({ error: "route_not_found" });
    if (String(routeSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const current = await db.collection("trip-routes").doc(routeId).collection("stops").doc(stopId).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.orderId !== undefined) patch.orderId = normalizeText(body.orderId);
    if (body.sequence !== undefined || body.order !== undefined) {
      const seq = Number(body.sequence ?? body.order) || 0;
      patch.sequence = seq;
      patch.order = seq;
    }
    if (body.eta !== undefined) patch.eta = body.eta || "";
    if (body.arrivalWindowStart !== undefined) patch.arrivalWindowStart = body.arrivalWindowStart || "";
    if (body.arrivalWindowEnd !== undefined) patch.arrivalWindowEnd = body.arrivalWindowEnd || "";
    if (body.status !== undefined) patch.status = STOP_STATUSES.includes(String(body.status)) ? body.status : current.data()?.status;
    if (body.type !== undefined) patch.type = STOP_TYPES.includes(String(body.type)) ? body.type : current.data()?.type;
    if (body.name !== undefined) patch.name = normalizeText(body.name);
    if (body.address !== undefined) patch.address = normalizeText(body.address);
    if (body.lat !== undefined) patch.lat = Number(body.lat) || 0;
    if (body.lng !== undefined) patch.lng = Number(body.lng) || 0;
    if (body.estimatedArrivalOffsetMinutes !== undefined) patch.estimatedArrivalOffsetMinutes = Number(body.estimatedArrivalOffsetMinutes) || 0;
    await db.collection("trip-routes").doc(routeId).collection("stops").doc(stopId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id/stops/:stopId PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/transport/routes/:routeId/stops/:stopId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { routeId, stopId } = req.params;
    const routeSnap = await db.collection("trip-routes").doc(routeId).get();
    if (!routeSnap.exists) return res.status(404).json({ error: "route_not_found" });
    if (String(routeSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("trip-routes").doc(routeId).collection("stops").doc(stopId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/transport/routes/:id/stops/:stopId DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// === Billing / Invoices ===

function toInvoiceRecord(doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const client = (d.client && typeof d.client === "object") ? (d.client as Record<string, unknown>) : {};
  const company = (d.company && typeof d.company === "object") ? (d.company as Record<string, unknown>) : {};
  const companyLocation = (d.companyLocation && typeof d.companyLocation === "object") ? (d.companyLocation as Record<string, unknown>) : {};
  return { id: doc.id, documentNo: String(d.documentNo ?? ""), type: String(d.type ?? ""), payTerm: String(d.payTerm ?? ""), settlementId: String(d.settlementId ?? ""), settlement: String(d.settlement ?? ""), client: { id: String(client.id ?? ""), name: String(client.name ?? ""), businessName: String(client.businessName ?? ""), identityDocumentNo: String(client.identityDocumentNo ?? ""), phoneNumber: String(client.phoneNumber ?? ""), emailAddress: String(client.emailAddress ?? ""), homeAddress: String(client.homeAddress ?? "") }, company: { id: String(company.id ?? ""), name: String(company.name ?? ""), businessName: String(company.businessName ?? ""), identityDocumentNo: String(company.identityDocumentNo ?? ""), emailAddress: String(company.emailAddress ?? ""), logoUrl: String(company.logoUrl ?? "") }, companyLocation: { name: String(companyLocation.name ?? ""), description: String(companyLocation.description ?? ""), ubigeo: String(companyLocation.ubigeo ?? ""), city: String(companyLocation.city ?? ""), country: String(companyLocation.country ?? ""), district: String(companyLocation.district ?? ""), address: String(companyLocation.address ?? "") }, issueDate: String(d.issueDate ?? ""), currency: String(d.currency ?? ""), status: String(d.status ?? ""), totalPrice: Number(d.totalPrice) || 0, totalTax: Number(d.totalTax) || 0, totalAmount: Number(d.totalAmount) || 0, comment: String(d.comment ?? ""), zipUrl: String(d.zipUrl ?? ""), cdrUrl: String(d.cdrUrl ?? ""), pdfUrl: String(d.pdfUrl ?? ""), operationTypeCode: String(d.operationTypeCode ?? "0101"), ...(d.dueDate != null && { dueDate: String(d.dueDate) }), ...(d.issueBlockReason != null && { issueBlockReason: String(d.issueBlockReason).trim() }), ...(d.saleOrderId && { saleOrderId: String(d.saleOrderId) }), ...(d.saleOrderCode && { saleOrderCode: String(d.saleOrderCode) }) };
}

function toInvoiceItemRecord(doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const measure = (d.measure && typeof d.measure === "object") ? (d.measure as Record<string, unknown>) : {};
  const taxType = (d.taxType && typeof d.taxType === "object") ? (d.taxType as Record<string, unknown>) : {};
  return { id: doc.id, itemId: String(d.itemId ?? ""), itemName: String(d.itemName ?? ""), description: String(d.description ?? ""), itemType: String(d.itemType ?? ""), measure: { id: String(measure.id ?? ""), name: String(measure.name ?? ""), code: String(measure.code ?? "") }, taxType: { id: String(taxType.id ?? ""), name: String(taxType.name ?? ""), refCode: String(taxType.refCode ?? ""), taxPer: Number(taxType.taxPer) || 0 }, quantity: Number(d.quantity) || 0, unitPrice: Number(d.unitPrice) || 0, price: Number(d.price) || 0, tax: Number(d.tax) || 0, amount: Number(d.amount) || 0, currency: String(d.currency ?? ""), taxAffectationCode: String(d.taxAffectationCode ?? "10"), taxSchemeCode: String(d.taxSchemeCode ?? "1000"), taxSchemeName: String(d.taxSchemeName ?? "IGV"), taxTypeCode: String(d.taxTypeCode ?? "VAT"), unitCode: String(d.unitCode ?? "NIU"), ...(d.itemCode != null && { itemCode: String(d.itemCode) }), ...(d.iscAmount != null && { iscAmount: Number(d.iscAmount) }), ...(d.icbperUnitAmount != null && { icbperUnitAmount: Number(d.icbperUnitAmount) }) };
}

function toInvoiceCreditRecord(doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return { id: doc.id, correlative: Number(d.correlative) || 0, dueDate: String(d.dueDate ?? ""), creditVal: Number(d.creditVal) || 0 };
}

webRouter.get("/billing/invoices", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const issueDateFrom = String(req.query.issueDateFrom ?? "").trim();
    const issueDateTo = String(req.query.issueDateTo ?? "").trim();
    const statuses = (req.query.status as string ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const clientIds = (req.query.clientIds as string ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    let q = db.collection("invoices").where("companyId", "==", companyId).where("accountId", "==", accountId) as FirebaseFirestore.Query;
    if (issueDateFrom) q = q.where("issueDate", ">=", `${issueDateFrom}T00:00:00.000`);
    if (issueDateTo) q = q.where("issueDate", "<=", `${issueDateTo}T23:59:59.999`);
    if (statuses.length === 1) q = q.where("status", "==", statuses[0]);
    if (clientIds.length === 1) q = q.where("client.id", "==", clientIds[0]);
    let snap = await q.get();
    if (statuses.length > 1 || clientIds.length > 1) {
      const allowedStatuses = new Set(statuses);
      const allowedClientIds = new Set(clientIds);
      const allowedIds = new Set<string>();
      for (const doc of snap.docs) {
        const d = doc.data();
        if ((statuses.length > 1 && allowedStatuses.has(String(d.status ?? ""))) ||
            (clientIds.length > 1 && allowedClientIds.has(String((d.client as Record<string, unknown> ?? {}).id ?? "")))) {
          allowedIds.add(doc.id);
        }
      }
      const allSnap = await db.collection("invoices").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
      for (const doc of allSnap.docs) {
        const d = doc.data();
        if ((statuses.length > 1 && allowedStatuses.has(String(d.status ?? ""))) ||
            (clientIds.length > 1 && allowedClientIds.has(String((d.client as Record<string, unknown> ?? {}).id ?? "")))) {
          allowedIds.add(doc.id);
        }
      }
      snap = allSnap.docs.filter((d) => allowedIds.has(d.id)) as unknown as FirebaseFirestore.QuerySnapshot;
    }
    const items = snap.docs.map((d) => toInvoiceRecord(d));
    res.status(200).json({ items, total: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/invoices/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("invoices").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toInvoiceRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/billing/invoices", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    const docRef = db.collection("invoices").doc();
    await docRef.set({ companyId, accountId, documentNo: String(body.documentNo ?? "").trim(), type: String(body.type ?? ""), payTerm: String(body.payTerm ?? ""), settlementId: String(body.settlementId ?? ""), settlement: String(body.settlement ?? ""), client: body.client && typeof body.client === "object" ? body.client : {}, company: body.company && typeof body.company === "object" ? body.company : {}, companyLocation: body.companyLocation && typeof body.companyLocation === "object" ? body.companyLocation : {}, issueDate: String(body.issueDate ?? ""), currency, status: String(body.status ?? "draft"), totalPrice: Number(body.totalPrice) || 0, totalTax: Number(body.totalTax) || 0, totalAmount: Number(body.totalAmount) || 0, comment: String(body.comment ?? ""), zipUrl: String(body.zipUrl ?? ""), cdrUrl: String(body.cdrUrl ?? ""), pdfUrl: String(body.pdfUrl ?? ""), operationTypeCode: String(body.operationTypeCode ?? "0101"), ...(body.dueDate != null && { dueDate: body.dueDate }), ...(body.saleOrderId && { saleOrderId: String(body.saleOrderId) }), ...(body.saleOrderCode && { saleOrderCode: String(body.saleOrderCode) }), createdAt: now, updatedAt: now });
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "invoices-count", delta: 1 }).catch(() => {});
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    if (msg === "company_currency_config_missing") {
      return res.status(412).json({ error: msg });
    }
    if (msg === "currency_not_allowed") {
      return res.status(422).json({ error: msg });
    }
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/billing/invoices/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = req.params.id;
    const current = await db.collection("invoices").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ["documentNo","type","payTerm","settlementId","settlement","client","company","companyLocation","issueDate","currency","status","totalPrice","totalTax","totalAmount","comment","zipUrl","cdrUrl","pdfUrl","operationTypeCode","dueDate","issueBlockReason","saleOrderId","saleOrderCode"] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    await db.collection("invoices").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    if (msg === "company_currency_config_missing") {
      return res.status(412).json({ error: msg });
    }
    if (msg === "currency_not_allowed") {
      return res.status(422).json({ error: msg });
    }
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/billing/invoices/:id", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = req.params.id;
    const current = await db.collection("invoices").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    const data = current.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const [itemsSnap, creditsSnap] = await Promise.all([db.collection("invoices").doc(id).collection("invoiceItems").get(), db.collection("invoices").doc(id).collection("invoiceCredits").get()]);
    await Promise.all([...itemsSnap.docs.map((d) => d.ref.delete()), ...creditsSnap.docs.map((d) => d.ref.delete())]);
    await db.collection("invoices").doc(id).delete();
    // Fire-and-forget: update tenant stats counter
    adjustCount(db, { accountId, companyId, metricKey: "invoices-count", delta: -1 }).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/invoices/:invoiceId/items", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("invoices").doc(invoiceId).collection("invoiceItems").get();
    return res.status(200).json({ items: snap.docs.map((d) => toInvoiceItemRecord(d)) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/items GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/invoices/:invoiceId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, itemId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("invoices").doc(invoiceId).collection("invoiceItems").doc(itemId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toInvoiceItemRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/items/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/billing/invoices/:invoiceId/items", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    const docRef = db.collection("invoices").doc(invoiceId).collection("invoiceItems").doc();
    await docRef.set({ companyId, accountId, itemId: String(body.itemId ?? ""), itemName: String(body.itemName ?? ""), description: String(body.description ?? ""), itemType: String(body.itemType ?? ""), measure: body.measure && typeof body.measure === "object" ? body.measure : {}, taxType: body.taxType && typeof body.taxType === "object" ? body.taxType : {}, quantity: Number(body.quantity) || 0, unitPrice: Number(body.unitPrice) || 0, price: Number(body.price) || 0, tax: Number(body.tax) || 0, amount: Number(body.amount) || 0, currency, taxAffectationCode: String(body.taxAffectationCode ?? "10"), taxSchemeCode: String(body.taxSchemeCode ?? "1000"), taxSchemeName: String(body.taxSchemeName ?? "IGV"), taxTypeCode: String(body.taxTypeCode ?? "VAT"), unitCode: String(body.unitCode ?? "NIU"), ...(body.itemCode != null && { itemCode: body.itemCode }), ...(body.iscAmount != null && { iscAmount: Number(body.iscAmount) }), ...(body.icbperUnitAmount != null && { icbperUnitAmount: Number(body.icbperUnitAmount) }), createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/items POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    if (msg === "company_currency_config_missing") {
      return res.status(412).json({ error: msg });
    }
    if (msg === "currency_not_allowed") {
      return res.status(422).json({ error: msg });
    }
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/billing/invoices/:invoiceId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, itemId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ["itemId","itemName","description","itemType","measure","taxType","quantity","unitPrice","price","tax","amount","currency","taxAffectationCode","taxSchemeCode","taxSchemeName","taxTypeCode","unitCode","itemCode","iscAmount","icbperUnitAmount"] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.currency !== undefined) {
      patch.currency = await normalizeCurrencyOrThrow(db, companyId, body.currency);
    }
    await db.collection("invoices").doc(invoiceId).collection("invoiceItems").doc(itemId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/items/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    if (msg === "company_currency_config_missing") {
      return res.status(412).json({ error: msg });
    }
    if (msg === "currency_not_allowed") {
      return res.status(422).json({ error: msg });
    }
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/billing/invoices/:invoiceId/items/:itemId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, itemId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("invoices").doc(invoiceId).collection("invoiceItems").doc(itemId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/items/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/invoices/:invoiceId/credits", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("invoices").doc(invoiceId).collection("invoiceCredits").get();
    return res.status(200).json({ items: snap.docs.map((d) => toInvoiceCreditRecord(d)) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/credits GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/invoices/:invoiceId/credits/:creditId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, creditId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const snap = await db.collection("invoices").doc(invoiceId).collection("invoiceCredits").doc(creditId).get();
    if (!snap.exists) return res.status(200).json(null);
    return res.status(200).json(toInvoiceCreditRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/credits/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/billing/invoices/:invoiceId/credits", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("invoices").doc(invoiceId).collection("invoiceCredits").doc();
    await docRef.set({ companyId, accountId, correlative: Number(body.correlative) || 0, dueDate: String(body.dueDate ?? ""), creditVal: Number(body.creditVal) || 0, createdAt: now, updatedAt: now });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/credits POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/billing/invoices/:invoiceId/credits/:creditId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, creditId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.correlative !== undefined) patch.correlative = Number(body.correlative) || 0;
    if (body.dueDate !== undefined) patch.dueDate = String(body.dueDate);
    if (body.creditVal !== undefined) patch.creditVal = Number(body.creditVal) || 0;
    await db.collection("invoices").doc(invoiceId).collection("invoiceCredits").doc(creditId).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/credits/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/billing/invoices/:invoiceId/credits/:creditId", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { invoiceId, creditId } = req.params;
    const invSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invSnap.exists) return res.status(404).json({ error: "invoice_not_found" });
    if (String(invSnap.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("invoices").doc(invoiceId).collection("invoiceCredits").doc(creditId).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/invoices/:id/credits/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// === Billing / SUNAT Config ===

webRouter.get("/billing/sunat-config", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("sunat-config").where("companyId", "==", companyId).where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => {
      const d = doc.data() ?? {};
      return { id: doc.id, name: String(d.name ?? "Configuración SUNAT").trim() || "Configuración SUNAT", active: d.active !== false, urlServidorSunat: String(d.urlServidorSunat ?? ""), urlConsultaServidorSunat: String(d.urlConsultaServidorSunat ?? ""), usuarioSunat: String(d.usuarioSunat ?? ""), passwordSunat: String(d.passwordSunat ?? ""), certBase64: String(d.certBase64 ?? ""), passwordCertificado: String(d.passwordCertificado ?? ""), hasCert: Boolean(d.certBase64), certOriginalFileName: d.certOriginalFileName ? String(d.certOriginalFileName) : undefined };
    });
    items.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-config GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/billing/sunat-config/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("sunat-config").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const d = snap.data() ?? {};
    if (String(d.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json({ id: snap.id, name: String(d.name ?? "Configuración SUNAT").trim() || "Configuración SUNAT", active: d.active !== false, urlServidorSunat: String(d.urlServidorSunat ?? ""), urlConsultaServidorSunat: String(d.urlConsultaServidorSunat ?? ""), usuarioSunat: String(d.usuarioSunat ?? ""), passwordSunat: String(d.passwordSunat ?? ""), certBase64: String(d.certBase64 ?? ""), passwordCertificado: String(d.passwordCertificado ?? ""), hasCert: Boolean(d.certBase64), certOriginalFileName: d.certOriginalFileName ? String(d.certOriginalFileName) : undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-config/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/billing/sunat-config", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const docRef = db.collection("sunat-config").doc();
    await docRef.set({
      companyId, accountId,
      name: String(body.name ?? "Configuración SUNAT").trim() || "Configuración SUNAT",
      active: body.active !== false,
      urlServidorSunat: String(body.urlServidorSunat ?? ""),
      urlConsultaServidorSunat: String(body.urlConsultaServidorSunat ?? ""),
      usuarioSunat: String(body.usuarioSunat ?? ""),
      passwordSunat: String(body.passwordSunat ?? ""),
      certBase64: String(body.certBase64 ?? ""),
      passwordCertificado: String(body.passwordCertificado ?? ""),
      ...(body.certOriginalFileName != null && { certOriginalFileName: body.certOriginalFileName }),
      createdAt: now, updatedAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-config POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/billing/sunat-config/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = req.params.id;
    const current = await db.collection("sunat-config").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const keys = ["name","active","urlServidorSunat","urlConsultaServidorSunat","usuarioSunat","passwordSunat","certBase64","passwordCertificado","certOriginalFileName"] as const;
    for (const key of keys) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    await db.collection("sunat-config").doc(id).update(patch);
    if (patch.active) {
      const allSnap = await db.collection("sunat-config").where("companyId", "==", companyId).get();
      await Promise.all(allSnap.docs.filter((d) => d.id !== id && d.data().active !== false).map((d) => d.ref.update({ active: false })));
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-config/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/billing/sunat-config/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const id = req.params.id;
    const current = await db.collection("sunat-config").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    const data = current.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("sunat-config").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-config/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// === Billing / SUNAT Monitor ===

function toEpochMsAdmin(ts: unknown): number | null {
  if (!ts) return null;
  if (typeof (ts as { toMillis?: () => number }).toMillis === "function") return (ts as { toMillis: () => number }).toMillis();
  if (typeof (ts as { toDate?: () => Date }).toDate === "function") return (ts as { toDate: () => Date }).toDate().getTime();
  const d = new Date(String(ts));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

webRouter.get("/billing/sunat-monitor/jobs", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const fromRaw = String(req.query.from ?? "").trim();
    const toRaw = String(req.query.to ?? "").trim();
    const statuses = (req.query.status as string ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const jobTypes = (req.query.jobType as string ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const docTypes = (req.query.docType as string ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const documentNo = String(req.query.documentNo ?? "").trim().toLowerCase();

    let q = db.collection("sunat-jobs").where("companyId", "==", companyId) as FirebaseFirestore.Query;
    if (fromRaw) {
      const d = new Date(`${fromRaw}T00:00:00`);
      if (Number.isFinite(d.getTime())) q = q.where("createdAt", ">=", FirebaseFirestore.Timestamp.fromDate(d));
    }
    if (toRaw) {
      const d = new Date(`${toRaw}T23:59:59.999`);
      if (Number.isFinite(d.getTime())) q = q.where("createdAt", "<=", FirebaseFirestore.Timestamp.fromDate(d));
    }
    q = q.orderBy("createdAt", "desc").limit(500) as FirebaseFirestore.Query;
    const snap = await q.get();

    const statusSet = new Set(statuses);
    const jobTypeSet = new Set(jobTypes);
    const docTypeSet = new Set(docTypes);

    const items = snap.docs
      .map((doc) => {
        const d = doc.data() ?? {};
        return {
          id: doc.id,
          companyId: String(d.companyId ?? ""),
          jobType: String(d.jobType ?? ""),
          status: String(d.status ?? ""),
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          invoiceId: d.invoiceId ? String(d.invoiceId) : undefined,
          documentNo: d.documentNo ? String(d.documentNo) : undefined,
          docType: d.docType ? String(d.docType) : undefined,
          issueDate: d.issueDate ? String(d.issueDate) : undefined,
          zipUrl: d.zipUrl ? String(d.zipUrl) : undefined,
          xmlUrl: d.xmlUrl ? String(d.xmlUrl) : undefined,
          cdrUrl: d.cdrUrl ? String(d.cdrUrl) : undefined,
          pdfUrl: d.pdfUrl ? String(d.pdfUrl) : undefined,
          sunatResponse: d.sunatResponse ? String(d.sunatResponse) : undefined,
          errorMessage: d.errorMessage ? String(d.errorMessage) : undefined,
          cdrMessages: Array.isArray(d.cdrMessages) ? d.cdrMessages.map((x) => String(x ?? "").trim()).filter(Boolean) : undefined,
        };
      })
      .filter((j) => {
        if (statusSet.size && !statusSet.has(j.status)) return false;
        if (jobTypeSet.size && !jobTypeSet.has(j.jobType)) return false;
        if (docTypeSet.size && !docTypeSet.has(j.docType ?? "")) return false;
        if (documentNo && !j.documentNo?.toLowerCase().includes(documentNo)) return false;
        return true;
      })
      .map((j) => {
        const createdAtMs = toEpochMsAdmin(j.createdAt);
        const updatedAtMs = toEpochMsAdmin(j.updatedAt);
        const fmt = (ms: number | null) => ms ? new Date(ms).toLocaleString() : "—";
        return { ...j, createdAtMs, createdAtLabel: fmt(createdAtMs), updatedAtMs };
      });

    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/billing/sunat-monitor/jobs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Report Definitions (reports) =====

function toReportDefinitionRecord(doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  const validSources = ["trips", "purchase-orders", "sale-orders", "quotations", "inventory-movements", "stock-valuation"];
  const rawSource = String(d.source ?? "trips").trim();
  return {
    id: doc.id,
    name: normalizeText(d.name),
    source: validSources.includes(rawSource) ? rawSource : "trips",
    rowGranularity: d.rowGranularity ?? "perTrip",
    layoutKind: d.layoutKind ?? "pivot",
    templateId: d.templateId ?? "dd-despacho-domicilio",
    outputFormat: d.outputFormat === "pdf" ? "pdf" : "xlsx",
    header: d.header && typeof d.header === "object" ? d.header : undefined,
    columns: Array.isArray(d.columns) ? d.columns : undefined,
    columnLayout: Array.isArray(d.columnLayout) ? d.columnLayout : undefined,
    footer: d.footer && typeof d.footer === "object" ? d.footer : undefined,
    exportTag: normalizeText(d.exportTag),
    exportTitleTemplate: normalizeText(d.exportTitleTemplate),
    exportFileNameTemplate: normalizeText(d.exportFileNameTemplate),
    includeSubtotalsIgft: d.includeSubtotalsIgft !== false,
    topBlock: d.topBlock && typeof d.topBlock === "object" ? d.topBlock : undefined,
    defaultParams: d.defaultParams && typeof d.defaultParams === "object" ? d.defaultParams : undefined,
    pivotSpec: d.pivotSpec && typeof d.pivotSpec === "object" ? d.pivotSpec : undefined,
    schedule: d.schedule && typeof d.schedule === "object" ? d.schedule : undefined,
    notifyEmails: Array.isArray(d.notifyEmails) ? d.notifyEmails.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : undefined,
    notifyEmailSubjectTemplate: normalizeText(d.notifyEmailSubjectTemplate),
    notifyEmailBodyHtml: normalizeText(d.notifyEmailBodyHtml),
    permissionModule: normalizeText(d.permissionModule),
    createAt: d.createAt ?? d.createdAt,
    createBy: normalizeText(d.createBy),
    updateAt: d.updateAt,
  };
}

function toReportRunRecord(doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    reportDefinitionId: normalizeText(d.reportDefinitionId),
    params: d.params && typeof d.params === "object" ? d.params : undefined,
    status: ["pending", "processing", "completed", "error"].includes(String(d.status)) ? d.status : "pending",
    trigger: normalizeText(d.trigger),
    outputFormat: normalizeText(d.outputFormat),
    requestedBy: normalizeText(d.requestedBy),
    result: d.result && typeof d.result === "object" ? d.result : undefined,
    errorMessage: normalizeText(d.errorMessage),
    notifyStatus: normalizeText(d.notifyStatus),
    notifyError: normalizeText(d.notifyError),
    notifyAttemptedAt: d.notifyAttemptedAt ?? d.notifyAttemptedAt,
    notifyEmailSubject: normalizeText(d.notifyEmailSubject),
    notifyRecipientsSummary: normalizeText(d.notifyRecipientsSummary),
    notifyBodyWasHtml: typeof d.notifyBodyWasHtml === "boolean" ? d.notifyBodyWasHtml : undefined,
    notifySkippedReason: normalizeText(d.notifySkippedReason),
    createdAt: d.createdAt ?? d.createAt,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
  };
}

webRouter.get("/reports/definitions", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db
      .collection("report-definitions")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .get();
    const items = snap.docs.map(toReportDefinitionRecord);
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/reports/definitions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const snap = await db.collection("report-definitions").doc(req.params.id).get();
    if (!snap.exists) return res.status(200).json(null);
    const data = snap.data() ?? {};
    if (String(data.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    return res.status(200).json(toReportDefinitionRecord(snap as any));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions/:id GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/reports/definitions", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    if (!body.name?.trim()) return res.status(400).json({ error: "name_required" });

    const docRef = db.collection("report-definitions").doc();
    const validSources = ["trips", "purchase-orders", "sale-orders", "quotations", "inventory-movements", "stock-valuation"];
    const rawSource = String(body.source ?? "trips").trim();
    const doc = {
      companyId, accountId,
      name: String(body.name ?? "").trim(),
      source: validSources.includes(rawSource) ? rawSource : "trips",
      rowGranularity: body.rowGranularity ?? "perTrip",
      layoutKind: body.layoutKind ?? "pivot",
      templateId: body.templateId ?? "dd-despacho-domicilio",
      outputFormat: body.outputFormat ?? "xlsx",
      columns: Array.isArray(body.columns) ? body.columns : [],
      topBlock: body.topBlock && typeof body.topBlock === "object" ? body.topBlock : undefined,
      footer: body.footer && typeof body.footer === "object" ? body.footer : undefined,
      exportTag: normalizeText(body.exportTag),
      exportTitleTemplate: normalizeText(body.exportTitleTemplate),
      exportFileNameTemplate: normalizeText(body.exportFileNameTemplate),
      includeSubtotalsIgft: body.includeSubtotalsIgft !== false,
      pivotSpec: body.pivotSpec && typeof body.pivotSpec === "object" ? body.pivotSpec : undefined,
      schedule: body.schedule && typeof body.schedule === "object" ? body.schedule : undefined,
      ...(Array.isArray(body.notifyEmails) && body.notifyEmails.length ? { notifyEmails: body.notifyEmails } : {}),
      ...(body.notifyEmailSubjectTemplate ? { notifyEmailSubjectTemplate: body.notifyEmailSubjectTemplate } : {}),
      ...(body.notifyEmailBodyHtml ? { notifyEmailBodyHtml: body.notifyEmailBodyHtml } : {}),
      ...(body.permissionModule ? { permissionModule: String(body.permissionModule).trim() } : {}),
      createAt: now,
      createBy: String((req as any)?.auth?.uid ?? "").trim() || "web",
      updateAt: now,
    };
    await docRef.set(doc);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.put("/reports/definitions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("report-definitions").doc(id).get();
    if (!current.exists) return res.status(404).json({ error: "not_found" });
    const currentData = current.data() ?? {};
    if (String(currentData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const now = new Date();
    const body = req.body ?? {};
    const patch: Record<string, unknown> = { updateAt: now };
    const safeFields = ["name", "source", "rowGranularity", "layoutKind", "templateId", "outputFormat",
      "exportTag", "exportTitleTemplate", "exportFileNameTemplate", "includeSubtotalsIgft"];
    for (const f of safeFields) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    if (Array.isArray(body.columns)) patch.columns = body.columns;
    if (body.topBlock !== undefined) patch.topBlock = body.topBlock;
    if (body.footer !== undefined) patch.footer = body.footer;
    if (body.pivotSpec !== undefined) patch.pivotSpec = body.pivotSpec;
    if (body.schedule !== undefined) patch.schedule = body.schedule;
    if (body.notifyEmails !== undefined) patch.notifyEmails = Array.isArray(body.notifyEmails) ? body.notifyEmails : null;
    if (body.notifyEmailSubjectTemplate !== undefined) patch.notifyEmailSubjectTemplate = body.notifyEmailSubjectTemplate || null;
    if (body.notifyEmailBodyHtml !== undefined) patch.notifyEmailBodyHtml = body.notifyEmailBodyHtml || null;

    await db.collection("report-definitions").doc(id).update(patch);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions/:id PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.delete("/reports/definitions/:id", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const current = await db.collection("report-definitions").doc(id).get();
    if (!current.exists) return res.status(200).json({ ok: true });
    if (String(current.data()?.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });
    await db.collection("report-definitions").doc(id).delete();
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions/:id DELETE] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Report Runs (reports) =====

webRouter.get("/reports/runs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const max = Math.min(Number(req.query.limit ?? 80), 200);
    const snap = await db
      .collection("report-runs")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .orderBy("createdAt", "desc")
      .limit(max)
      .get();
    const items = snap.docs.map(toReportRunRecord);
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/runs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.get("/reports/definitions/:definitionId/runs", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const max = Math.min(Number(req.query.limit ?? 200), 500);
    const definitionId = String(req.params.definitionId ?? "").trim();
    if (!definitionId) return res.status(400).json({ error: "definitionId_required" });

    const snap = await db
      .collection("report-runs")
      .where("companyId", "==", companyId)
      .where("accountId", "==", accountId)
      .where("reportDefinitionId", "==", definitionId)
      .orderBy("createdAt", "desc")
      .limit(max)
      .get();
    const items = snap.docs.map(toReportRunRecord);
    res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/definitions/:definitionId/runs GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Report Callable → REST endpoints =====

webRouter.post("/reports/run/create", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const body = req.body ?? {};
    const reportDefinitionId = String(body.reportDefinitionId ?? "").trim();
    if (!reportDefinitionId) return res.status(400).json({ error: "reportDefinitionId_required" });

    const db = getWebFirestore();
    const defSnap = await db.collection("report-definitions").doc(reportDefinitionId).get();
    if (!defSnap.exists) return res.status(404).json({ error: "definition_not_found" });
    const defData = defSnap.data() ?? {};
    if (String(defData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    const now = new Date();
    const uid = String((req as any)?.auth?.uid ?? "").trim();
    const params = (body.params && typeof body.params === "object") ? body.params : {};
    const outputFormat = String(body.outputFormat ?? defData.outputFormat ?? "xlsx").toLowerCase();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId,
      companyId,
      accountId: String(defData.accountId ?? "").trim(),
      params,
      status: "pending",
      trigger: body.trigger ?? "manual",
      outputFormat: outputFormat === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: now,
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/run/create POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/reports/run/:runId/download-url", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const runId = String(req.params.runId ?? "").trim();
    if (!runId) return res.status(400).json({ error: "runId_required" });

    const runSnap = await db.collection("report-runs").doc(runId).get();
    if (!runSnap.exists) return res.status(404).json({ error: "run_not_found" });
    const runData = runSnap.data() ?? {};
    if (String(runData.companyId ?? "").trim() !== companyId) return res.status(403).json({ error: "forbidden" });

    if (runData.status !== "completed") {
      return res.status(409).json({ error: "run_not_completed", message: "La corrida no ha finalizado." });
    }
    const result = runData.result && typeof runData.result === "object" ? runData.result as Record<string, unknown> : {};
    const url = String(result.url ?? result.downloadUrl ?? result.downloadUrl ?? "").trim();
    const fileName = String(result.fileName ?? result.filename ?? `${runId}.xlsx`).trim();

    if (!url) return res.status(409).json({ error: "no_download_url", message: "URL de descarga no disponible." });
    res.status(200).json({ url, fileName });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/run/:runId/download-url POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

webRouter.post("/reports/preview", async (req, res) => {
  try {
    const { companyId } = await requireCompanyScope(req as any);
    const body = req.body ?? {};
    const params = (body.params && typeof body.params === "object") ? body.params : {};
    const rowGranularity = String(body.rowGranularity ?? "perTrip").trim();
    const outputKind = String(body.outputKind ?? "detail").trim();

    const db = getWebFirestore();
    const tripsSnap = await db
      .collection("trips")
      .where("companyId", "==", companyId)
      .where("status", "in", ["completed", "in_transit"])
      .limit(20)
      .get();

    const rows = tripsSnap.docs.map((doc) => {
      const d = doc.data() ?? {};
      return {
        tripId: doc.id,
        tripCode: normalizeText(d.code),
        driverName: normalizeText(d.driverName),
        vehiclePlate: normalizeText(d.vehiclePlate),
        completedAt: d.completedAt,
        totalAmount: Number(d.totalAmount ?? 0),
        chargeCount: Number(d.chargeCount ?? 0),
      };
    });

    res.status(200).json({ preview: rows, total: rows.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/preview POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

// ===== Report Generation Endpoints for Purchasing, Sales & Inventory =====

/**
 * POST /reports/generate/purchase-orders
 * Generates a purchase orders report for a given period with optional filters.
 */
webRouter.post("/reports/generate/purchase-orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const uid = String((req as any)?.auth?.uid ?? "").trim();

    const dateFrom = String(body.dateFrom ?? "").trim();
    const dateTo = String(body.dateTo ?? "").trim();
    if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom_and_dateTo_required" });

    const params: Record<string, unknown> = { dateFrom, dateTo };
    if (body.status) params.status = String(body.status).trim();
    if (body.supplierId) params.supplierId = String(body.supplierId).trim();
    if (body.locationId) params.locationId = String(body.locationId).trim();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId: body.reportDefinitionId || null,
      companyId,
      accountId,
      source: "purchase-orders",
      params,
      status: "pending",
      trigger: "manual",
      outputFormat: String(body.outputFormat ?? "xlsx").toLowerCase() === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/generate/purchase-orders POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

/**
 * POST /reports/generate/sale-orders
 * Generates a sale orders report for a given period with optional filters.
 */
webRouter.post("/reports/generate/sale-orders", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const uid = String((req as any)?.auth?.uid ?? "").trim();

    const dateFrom = String(body.dateFrom ?? "").trim();
    const dateTo = String(body.dateTo ?? "").trim();
    if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom_and_dateTo_required" });

    const params: Record<string, unknown> = { dateFrom, dateTo };
    if (body.status) params.status = String(body.status).trim();
    if (body.clientId) params.clientId = String(body.clientId).trim();
    if (body.locationId) params.locationId = String(body.locationId).trim();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId: body.reportDefinitionId || null,
      companyId,
      accountId,
      source: "sale-orders",
      params,
      status: "pending",
      trigger: "manual",
      outputFormat: String(body.outputFormat ?? "xlsx").toLowerCase() === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/generate/sale-orders POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

/**
 * POST /reports/generate/quotations
 * Generates a quotations report for a given period with optional filters.
 */
webRouter.post("/reports/generate/quotations", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const uid = String((req as any)?.auth?.uid ?? "").trim();

    const dateFrom = String(body.dateFrom ?? "").trim();
    const dateTo = String(body.dateTo ?? "").trim();
    if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom_and_dateTo_required" });

    const params: Record<string, unknown> = { dateFrom, dateTo };
    if (body.status) params.status = String(body.status).trim();
    if (body.clientId) params.clientId = String(body.clientId).trim();
    if (body.locationId) params.locationId = String(body.locationId).trim();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId: body.reportDefinitionId || null,
      companyId,
      accountId,
      source: "quotations",
      params,
      status: "pending",
      trigger: "manual",
      outputFormat: String(body.outputFormat ?? "xlsx").toLowerCase() === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/generate/quotations POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

/**
 * POST /reports/generate/inventory-movements
 * Generates an inventory movements report for a given period with optional filters.
 */
webRouter.post("/reports/generate/inventory-movements", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const uid = String((req as any)?.auth?.uid ?? "").trim();

    const dateFrom = String(body.dateFrom ?? "").trim();
    const dateTo = String(body.dateTo ?? "").trim();
    if (!dateFrom || !dateTo) return res.status(400).json({ error: "dateFrom_and_dateTo_required" });

    const params: Record<string, unknown> = { dateFrom, dateTo };
    if (body.type) params.type = String(body.type).trim();
    if (body.warehouseId) params.warehouseId = String(body.warehouseId).trim();
    if (body.productId) params.productId = String(body.productId).trim();
    if (body.locationId) params.locationId = String(body.locationId).trim();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId: body.reportDefinitionId || null,
      companyId,
      accountId,
      source: "inventory-movements",
      params,
      status: "pending",
      trigger: "manual",
      outputFormat: String(body.outputFormat ?? "xlsx").toLowerCase() === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/generate/inventory-movements POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

/**
 * POST /reports/generate/stock-valuation
 * Generates a stock valuation report with optional filters.
 */
webRouter.post("/reports/generate/stock-valuation", async (req, res) => {
  try {
    const { accountId, companyId } = await requireCompanyScope(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const uid = String((req as any)?.auth?.uid ?? "").trim();

    const params: Record<string, unknown> = {};
    if (body.warehouseId) params.warehouseId = String(body.warehouseId).trim();
    if (body.productId) params.productId = String(body.productId).trim();
    if (body.locationId) params.locationId = String(body.locationId).trim();

    const docRef = db.collection("report-runs").doc();
    await docRef.set({
      reportDefinitionId: body.reportDefinitionId || null,
      companyId,
      accountId,
      source: "stock-valuation",
      params,
      status: "pending",
      trigger: "manual",
      outputFormat: String(body.outputFormat ?? "xlsx").toLowerCase() === "pdf" ? "pdf" : "xlsx",
      requestedBy: uid,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true, id: docRef.id, status: "pending" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/reports/generate/stock-valuation POST] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" ? 403 : 500).json({ error: msg });
  }
});

async function getAccountIdFromAuth(req: any): Promise<string> {
  const uid = String(req?.auth?.uid ?? "").trim();
  if (!uid) throw new Error("unauthenticated");
  const db = getWebFirestore();
  const companyUserSnap = await db
    .collection("company-users")
    .where("userId", "==", uid)
    .limit(1)
    .get();
  if (companyUserSnap.empty) {
    throw new Error("forbidden");
  }
  const data = companyUserSnap.docs[0]!.data();
  let accountId = String(data.accountId ?? "").trim();
  if (!accountId) {
    const companyId = String(data.companyId ?? "").trim();
    if (companyId) {
      const company = await db.collection("companies").doc(companyId).get();
      accountId = String(company.data()?.accountId ?? companyId).trim() || companyId;
    }
  }
  if (!accountId) {
    throw new Error("accountId_not_found");
  }
  return accountId;
}

webRouter.get("/dashboard/snapshot", async (req, res) => {
  try {
    const accountId = await getAccountIdFromAuth(req);
    const periodRaw = String(req.query?.period ?? "").trim();
    const period = /^\d{4}-\d{2}$/.test(periodRaw) ? periodRaw : new Date().toISOString().slice(0, 7);
    const snapshotId = `${accountId}_${period}`;
    const snap = await getWebFirestore().collection("dashboard-snapshots").doc(snapshotId).get();
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
      period: String(data.period ?? period),
      cards: Array.isArray(data.cards) ? data.cards : [],
      activityReports: Array.isArray(data.activityReports) ? data.activityReports : [],
      activityTrips: Array.isArray(data.activityTrips) ? data.activityTrips : [],
      hasUsageForPeriod: Boolean(data.usage && typeof data.usage === "object" && Object.keys(data.usage).length > 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard/snapshot GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(msg === "forbidden" || msg === "accountId_not_found" ? 403 : 500).json({ error: msg });
  }
});

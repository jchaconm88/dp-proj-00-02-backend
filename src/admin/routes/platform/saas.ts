import { Router } from "express";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";
import { updateAdminEntitySearchIndex } from "../../../features/search/entity-search-index-admin.service.js";

const SUBSCRIPTION_STATUS_ALLOWED = new Set(["active", "inactive", "suspended", "cancelled"]);
const BILLING_CYCLE_ALLOWED = new Set(["monthly", "annual"]);

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function asOptionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  const parsed = String(value).trim();
  return parsed.length > 0 ? parsed : undefined;
}

function asSubscriptionStatus(value: unknown): "active" | "inactive" | "suspended" | "cancelled" {
  const parsed = String(value ?? "active").trim().toLowerCase();
  return SUBSCRIPTION_STATUS_ALLOWED.has(parsed)
    ? (parsed as "active" | "inactive" | "suspended" | "cancelled")
    : "active";
}

function asBillingCycle(value: unknown): "monthly" | "annual" | undefined {
  const parsed = String(value ?? "").trim().toLowerCase();
  return BILLING_CYCLE_ALLOWED.has(parsed) ? (parsed as "monthly" | "annual") : undefined;
}

function asCurrencyCode(value: unknown): string | undefined {
  const parsed = asOptionalText(value)?.toUpperCase();
  if (!parsed || parsed.length !== 3) return undefined;
  return parsed;
}

function asAmountCents(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed);
}

function asIsoDateString(value: unknown): string | undefined {
  const parsed = asOptionalText(value);
  if (!parsed) return undefined;
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

const router = Router();

// ─── Plans CRUD ──────────────────────────────────────────────────────────────

router.get("/plans", async (_req, res) => {
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

router.post("/plans", async (req, res) => {
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
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "plan",
      action: "create",
      recordId: String(id).trim(),
      fields: { name: String(name).trim() },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/plans/:id", async (req, res) => {
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
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "plan",
      action: "update",
      recordId: id,
      fields: { name: String(fields.name ?? existing.data()?.name ?? "") },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/plans/:id", async (req, res) => {
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
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "plan",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/plans DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Subscriptions CRUD ──────────────────────────────────────────────────────

router.get("/subscriptions", async (_req, res) => {
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

router.post("/subscriptions", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { id, planId, status = "active", billingCycle, nextRenewalAt, amountCents, currency, ...rest } = req.body ?? {};
    const parsedId = asOptionalText(id);
    const parsedPlanId = asOptionalText(planId);
    if (!parsedId || !parsedPlanId) return res.status(400).json({ error: "id_and_planId_required" });

    const normalizedBillingCycle = asBillingCycle(billingCycle);
    const normalizedNextRenewalAt = asIsoDateString(nextRenewalAt);
    const normalizedAmountCents = asAmountCents(amountCents);
    const normalizedCurrency = asCurrencyCode(currency);
    if (billingCycle !== undefined && normalizedBillingCycle === undefined) {
      return res.status(400).json({ error: "invalid_billingCycle" });
    }
    if (nextRenewalAt !== undefined && normalizedNextRenewalAt === undefined) {
      return res.status(400).json({ error: "invalid_nextRenewalAt" });
    }
    if (amountCents !== undefined && normalizedAmountCents === undefined) {
      return res.status(400).json({ error: "invalid_amountCents" });
    }
    if (currency !== undefined && normalizedCurrency === undefined) {
      return res.status(400).json({ error: "invalid_currency" });
    }

    await db.collection("subscriptions").doc(parsedId).set({
      accountId,
      planId: parsedPlanId,
      status: asSubscriptionStatus(status),
      ...(normalizedBillingCycle !== undefined && { billingCycle: normalizedBillingCycle }),
      ...(normalizedNextRenewalAt !== undefined && { nextRenewalAt: normalizedNextRenewalAt }),
      ...(normalizedAmountCents !== undefined && { amountCents: normalizedAmountCents }),
      ...(normalizedCurrency !== undefined && { currency: normalizedCurrency }),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ ok: true, id: parsedId });
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "subscription",
      action: "create",
      recordId: parsedId,
      fields: { planId: parsedPlanId, status: asSubscriptionStatus(status) },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/subscriptions/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, status, billingCycle, nextRenewalAt, amountCents, currency, ...fields } = req.body ?? {};
    const existing = await db.collection("subscriptions").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const patch: Record<string, unknown> = { ...fields };
    if (status !== undefined) patch.status = asSubscriptionStatus(status);
    if (billingCycle !== undefined) {
      const normalizedBillingCycle = asBillingCycle(billingCycle);
      if (normalizedBillingCycle === undefined) return res.status(400).json({ error: "invalid_billingCycle" });
      patch.billingCycle = normalizedBillingCycle;
    }
    if (nextRenewalAt !== undefined) {
      const normalizedNextRenewalAt = asIsoDateString(nextRenewalAt);
      if (normalizedNextRenewalAt === undefined) return res.status(400).json({ error: "invalid_nextRenewalAt" });
      patch.nextRenewalAt = normalizedNextRenewalAt;
    }
    if (amountCents !== undefined) {
      const normalizedAmountCents = asAmountCents(amountCents);
      if (normalizedAmountCents === undefined) return res.status(400).json({ error: "invalid_amountCents" });
      patch.amountCents = normalizedAmountCents;
    }
    if (currency !== undefined) {
      const normalizedCurrency = asCurrencyCode(currency);
      if (normalizedCurrency === undefined) return res.status(400).json({ error: "invalid_currency" });
      patch.currency = normalizedCurrency;
    }

    await db.collection("subscriptions").doc(id).update({
      ...patch,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "subscription",
      action: "update",
      recordId: id,
      fields: {
        planId: String(patch.planId ?? existing.data()?.planId ?? ""),
        status: String(patch.status ?? existing.data()?.status ?? ""),
      },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/subscriptions/:id", async (req, res) => {
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
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "subscription",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/subscriptions DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


import { Router } from "express";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";
import { updateAdminEntitySearchIndex } from "../../../features/search/entity-search-index-admin.service.js";

const ACCOUNT_STATUS_ALLOWED = new Set(["active", "inactive"]);

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

function asAccountStatus(value: unknown): "active" | "inactive" | undefined {
  const parsed = String(value ?? "").trim().toLowerCase();
  return ACCOUNT_STATUS_ALLOWED.has(parsed) ? (parsed as "active" | "inactive") : undefined;
}

const router = Router();

router.get("/", async (_req, res) => {
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

router.post("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const { name, status = "active", website, industry, location, ...rest } = req.body ?? {};
    const parsedName = asOptionalText(name);
    if (!parsedName) return res.status(400).json({ error: "name_required" });
    const parsedStatus = asAccountStatus(status);
    if (!parsedStatus) return res.status(400).json({ error: "invalid_status" });
    const parsedWebsite = asOptionalText(website);
    const parsedIndustry = asOptionalText(industry);
    const parsedLocation = asOptionalText(location);
    await db.collection("accounts").doc(accountId).set({
      name: parsedName,
      status: parsedStatus,
      ...(parsedWebsite !== undefined && { website: parsedWebsite }),
      ...(parsedIndustry !== undefined && { industry: parsedIndustry }),
      ...(parsedLocation !== undefined && { location: parsedLocation }),
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "account",
      action: "create",
      recordId: accountId,
      fields: { name: parsedName, status: parsedStatus },
    }).catch(() => {});
    res.status(201).json({ ok: true, id: accountId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    const { id: _id, createdAt: _ca, status, website, industry, location, ...fields } = req.body ?? {};
    const patch: Record<string, unknown> = { ...fields };
    if (status !== undefined) {
      const parsedStatus = asAccountStatus(status);
      if (!parsedStatus) return res.status(400).json({ error: "invalid_status" });
      patch.status = parsedStatus;
    }
    if (website !== undefined) patch.website = asOptionalText(website) ?? "";
    if (industry !== undefined) patch.industry = asOptionalText(industry) ?? "";
    if (location !== undefined) patch.location = asOptionalText(location) ?? "";

    await db.collection("accounts").doc(id).update({
      ...patch,
      updatedAt: new Date(),
    });
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "account",
      action: "update",
      recordId: id,
      fields: { name: String(patch.name ?? ""), status: String(patch.status ?? "") },
    }).catch(() => {});
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const { id } = req.params;
    if (String(id) !== accountId) return res.status(403).json({ error: "forbidden" });
    const db = getAdminFirestore();
    await db.collection("accounts").doc(id).delete();
    updateAdminEntitySearchIndex(db, {
      accountId,
      entityId: "account",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/accounts DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

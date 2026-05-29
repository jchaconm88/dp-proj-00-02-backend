import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function generateApiKey(): string {
  return `erp_${crypto.randomBytes(24).toString("hex")}`;
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const companyId = String(req.query.companyId ?? "").trim();
    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    const db = getWebFirestore();
    const snap = await db
      .collection("integration-credentials")
      .where("accountId", "==", accountId)
      .where("companyId", "==", companyId)
      .get();
    const items = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        companyId: data.companyId,
        label: data.label,
        integrator: data.integrator,
        apiKey: data.apiKey,
        webhookUrl: data.webhookUrl ?? null,
        defaultWarehouseCode: data.defaultWarehouseCode,
        priceListCode: data.priceListCode,
        syncMode: data.syncMode,
        status: data.status,
        createdAt: data.createdAt,
        lastUsedAt: data.lastUsedAt ?? null,
      };
    });
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("integration-credentials").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data()!;
    if (String(data.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.status(200).json({
      id: snap.id,
      companyId: data.companyId,
      label: data.label,
      integrator: data.integrator,
      apiKey: data.apiKey,
      webhookUrl: data.webhookUrl ?? null,
      webhookSecret: data.webhookSecret ? "(set)" : null,
      defaultWarehouseCode: data.defaultWarehouseCode,
      priceListCode: data.priceListCode,
      syncMode: data.syncMode,
      status: data.status,
      createdAt: data.createdAt,
      lastUsedAt: data.lastUsedAt ?? null,
      rotatedAt: data.rotatedAt ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const body = req.body ?? {};
    const companyId = String(body.companyId ?? "").trim();
    const label = String(body.label ?? "").trim();
    const integrator = String(body.integrator ?? "woocommerce").trim();
    if (!companyId) return res.status(400).json({ error: "companyId_required" });
    if (!label) return res.status(400).json({ error: "label_required" });
    const company = await db.collection("companies").doc(companyId).get();
    if (!company.exists || String(company.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const apiKey = generateApiKey();
    const apiSecret = generateSecret();
    const apiSecretHash = await bcrypt.hash(apiSecret, 10);
    const webhookSecret = body.webhookSecret || generateSecret();
    const docRef = await db.collection("integration-credentials").add({
      accountId,
      companyId,
      label,
      integrator,
      apiKey,
      apiKeyHash: apiKey,
      apiSecretHash,
      webhookSecret,
      webhookUrl: normalizeText(body.webhookUrl),
      defaultWarehouseCode: normalizeText(body.defaultWarehouseCode) || "LIMA-01",
      priceListCode: normalizeText(body.priceListCode) || "web",
      syncMode: body.syncMode === "manual" ? "manual" : "event_driven",
      status: "active",
      createdAt: new Date(),
    });
    res.status(201).json({
      id: docRef.id,
      apiKey,
      apiSecret,
      label,
      integrator,
      companyId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("integration-credentials").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const body = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (body.label !== undefined) updates.label = String(body.label).trim();
    if (body.webhookUrl !== undefined) updates.webhookUrl = normalizeText(body.webhookUrl);
    if (body.defaultWarehouseCode !== undefined) updates.defaultWarehouseCode = normalizeText(body.defaultWarehouseCode);
    if (body.priceListCode !== undefined) updates.priceListCode = normalizeText(body.priceListCode);
    if (body.syncMode !== undefined) updates.syncMode = body.syncMode === "manual" ? "manual" : "event_driven";
    if (body.webhookSecret !== undefined) {
      updates.webhookSecret = String(body.webhookSecret).trim();
    }
    if (Object.keys(updates).length > 0) {
      await db.collection("integration-credentials").doc(id).update(updates);
    }
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/:id/rotate-secret", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("integration-credentials").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const newSecret = generateSecret();
    const apiSecretHash = await bcrypt.hash(newSecret, 10);
    await db.collection("integration-credentials").doc(id).update({
      apiSecretHash,
      rotatedAt: new Date(),
    });
    res.status(200).json({ apiSecret: newSecret, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials rotate-secret] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/:id/revoke", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("integration-credentials").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("integration-credentials").doc(id).update({
      status: "revoked",
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials revoke] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("integration-credentials").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    const data = existing.data()!;
    if (String(data.status ?? "") !== "revoked") {
      return res.status(400).json({ error: "only_revoked_allowed", message: "Only revoked credentials can be deleted" });
    }
    await db.collection("integration-credentials").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/:id/test", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("integration-credentials").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.status(200).json({ ok: true, message: "Credential valid. Test health endpoint separate." });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/integration-credentials test] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

function normalizeText(value: unknown): string {
  const out = String(value ?? "").trim();
  return out || "";
}

export default router;

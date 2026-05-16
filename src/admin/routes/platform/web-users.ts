import { Router } from "express";
import { getAdminFirestore, getWebFirestore, getWebAuth } from "../../../lib/firebase-admin.js";
import { updateAdminEntitySearchIndex } from "../../../features/search/entity-search-index-admin.service.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

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

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const wDb = getWebFirestore();
    const snap = await wDb
      .collection("users")
      .where("accountId", "==", accountId)
      .where("platform", "array-contains", "web")
      .get();
    const items = snap.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        authUid: String(data.authUid ?? doc.id).trim(),
        email: String(data.email ?? "").trim(),
        displayName: String(data.displayName ?? "").trim(),
        accountId: String(data.accountId ?? "").trim() || undefined,
        status: String(data.status ?? "active").trim(),
        webRoleIds: Array.isArray(data.webRoleIds) ? data.webRoleIds.map((x: unknown) => String(x)) : [],
        webRoleNames: Array.isArray(data.webRoleNames) ? data.webRoleNames.map((x: unknown) => String(x)) : [],
        platform: Array.isArray(data.platform) ? data.platform.map((x: unknown) => String(x)) : [],
      };
    });
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const { id } = req.params;
    const snap = await wDb.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String(data.accountId ?? "") !== accountId) return res.status(403).json({ error: "forbidden" });
    const platform = Array.isArray(data.platform) ? data.platform : [];
    if (!platform.includes("web")) return res.status(404).json({ error: "not_found" });
    res.status(200).json({ id: snap.id, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/", async (req, res) => {
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
    
    const userPassword = String(password ?? "").trim() || generateRandomPassword(16);
    
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
      platform: ["web"],
      updatedAt: now,
      createdAt: now,
    };
    
    await wDb.collection("users").doc(authUid).set(payload);
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "web-user",
      action: "create",
      recordId: authUid,
      fields: {
        displayName: String(displayName).trim(),
        email: normalizedEmail,
        status: String(status).trim() === "inactive" ? "inactive" : "active",
      },
    }).catch(() => {});
    return res.status(201).json({ ok: true, id: authUid, authUid, generatedPassword: userPassword });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/:id", async (req, res) => {
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
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "web-user",
      action: "update",
      recordId: id,
      fields: {
        displayName: String((fields as any).displayName ?? existing.data()?.displayName ?? ""),
        email: String((fields as any).email ?? existing.data()?.email ?? ""),
        status: String((fields as any).status ?? existing.data()?.status ?? ""),
      },
    }).catch(() => {});
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const wAuth = getWebAuth();
    const { id } = req.params;
    const existing = await wDb.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    
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
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "web-user",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

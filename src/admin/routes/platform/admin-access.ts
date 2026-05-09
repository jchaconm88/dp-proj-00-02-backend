import { Router } from "express";
import {
  createAdminCustomRole,
  deleteAdminCustomRole,
  getMergedAdminRoleById,
  listMergedAdminRoles,
  roleHttpStatus,
  updateAdminCustomRole,
} from "../../../lib/merged-roles.service.js";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function usersDocIncludesPlatform(data: Record<string, unknown>, tag: string): boolean {
  const p = data.platform;
  return Array.isArray(p) && (p as unknown[]).map(String).includes(tag);
}

const router = Router();

// ─── Roles (Admin) — merge catálogo TS + colección `roles` ───────────────────

router.get("/roles", async (_req, res) => {
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

router.get("/roles/:id", async (req, res) => {
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

router.post("/roles", async (req, res) => {
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

router.put("/roles/:id", async (req, res) => {
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

router.delete("/roles/:id", async (req, res) => {
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

// ─── Users CRUD (Admin staff, platform contains "admin") ─────────────────────

router.get("/users", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getAdminFirestore();
    const snap = await db
      .collection("users")
      .where("accountId", "==", accountId)
      .where("platform", "array-contains", "admin")
      .get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const snap = await db.collection("users").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const data = snap.data() ?? {};
    if (String((data as any).accountId ?? "") !== accountId) return res.status(403).json({ error: "forbidden" });
    if (!usersDocIncludesPlatform(data as Record<string, unknown>, "admin")) return res.status(404).json({ error: "not_found" });
    res.status(200).json({ id: snap.id, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/users", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const now = new Date();
    const {
      id,
      email = "",
      displayName = "",
      status = "active",
      adminRoleIds = [],
      adminRoleNames = [],
      platform: _ignorePlatform,
      ...rest
    } = req.body ?? {};
    if (!id) return res.status(400).json({ error: "id_required" });
    await db.collection("users").doc(String(id).trim()).set(
      {
        userId: String(id).trim(),
        accountId,
        email: String(email).trim(),
        displayName: String(displayName).trim(),
        status: String(status).trim() === "inactive" ? "inactive" : "active",
        adminRoleIds: Array.isArray(adminRoleIds) ? adminRoleIds : [],
        adminRoleNames: Array.isArray(adminRoleNames) ? adminRoleNames : [],
        ...rest,
        platform: ["admin"],
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

router.put("/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (!usersDocIncludesPlatform(existing.data() as Record<string, unknown>, "admin")) {
      return res.status(404).json({ error: "not_found" });
    }
    const { id: _id, createdAt: _ca, accountId: _aid, userId: _uid, platform: _plat, ...fields } = req.body ?? {};
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

router.delete("/users/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getAdminFirestore();
    const { id } = req.params;
    const existing = await db.collection("users").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (!usersDocIncludesPlatform(existing.data() as Record<string, unknown>, "admin")) {
      return res.status(404).json({ error: "not_found" });
    }
    await db.collection("users").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import { updateAdminEntitySearchIndex } from "../../../features/search/entity-search-index-admin.service.js";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

const router = Router();

router.get("/company-users", async (_req, res) => {
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

router.post("/company-users", async (req, res) => {
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
    const userEmail = req.body?.userEmail !== undefined ? String(req.body.userEmail).trim().toLowerCase() : "";
    const userDisplayName = req.body?.userDisplayName !== undefined ? String(req.body.userDisplayName).trim() : "";
    const user = req.body?.user !== undefined ? String(req.body.user).trim() : "";
    const webRoleIdsParsed = Array.isArray(req.body?.webRoleIds) ? req.body.webRoleIds.map((x: unknown) => String(x)) : [];
    const webRoleNamesParsed = Array.isArray(req.body?.webRoleNames) ? req.body.webRoleNames.map((x: unknown) => String(x)) : [];
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
      webRoleIds: webRoleIdsParsed,
      webRoleNames: webRoleNamesParsed,
      status,
      createAt: now,
      updateAt: now,
      createBy: "admin",
      updateBy: "admin",
    });
    res.status(201).json({ ok: true, id });
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "company-user",
      action: "create",
      recordId: id,
      fields: {
        displayName: userDisplayName,
        email: userEmail,
        userId,
        status,
      },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/company-users/:id", async (req, res) => {
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
    if (Array.isArray(body.webRoleIds)) patch.webRoleIds = body.webRoleIds.map((x: unknown) => String(x));
    if (Array.isArray(body.webRoleNames)) patch.webRoleNames = body.webRoleNames.map((x: unknown) => String(x));
    if (body.status !== undefined) {
      patch.status = String(body.status).trim() === "inactive" ? "inactive" : "active";
    }
    await db.collection("company-users").doc(id).update(patch);
    res.status(200).json({ ok: true, id });
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "company-user",
      action: "update",
      recordId: id,
      fields: {
        displayName: String(patch.userDisplayName ?? snap.data()?.userDisplayName ?? ""),
        email: String(patch.userEmail ?? snap.data()?.userEmail ?? ""),
        userId: String(patch.userId ?? snap.data()?.userId ?? ""),
        status: String(patch.status ?? snap.data()?.status ?? ""),
      },
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users PUT] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/company-users/:id", async (req, res) => {
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
    updateAdminEntitySearchIndex(getAdminFirestore(), {
      accountId,
      entityId: "company-user",
      action: "delete",
      recordId: id,
      fields: {},
    }).catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/company-users DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


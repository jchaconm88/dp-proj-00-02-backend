import { Router } from "express";
import { getWebAuth, getWebFirestore } from "../../lib/firebase-admin.js";

const router = Router();

router.post("/invites", async (req, res) => {
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

    // 1) Ensure web admin role for the company
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
        description: "Administrador (invite)",
        permissions: { "*": ["*"] },
        platform: ["web"],
        createdAt: now,
        updateAt: now,
        createBy: "admin",
        updateBy: "admin",
      });
      adminRoleId = created.id;
    }

    // 2) Create invite token (docId = token for easy lookup)
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const inviteId = `${companyId}_${Date.now()}_${token.slice(0, 8)}`;
    await db.collection("invites").doc(inviteId).set(
      {
        inviteId,
        email,
        companyId,
        accountId,
        roleId: adminRoleId,
        roleName: "admin",
        displayName,
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

router.post("/invites/accept", async (req, res) => {
  try {
    const token = String(req.body?.token ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const displayName = String(req.body?.displayName ?? "").trim();
    const password = String(req.body?.password ?? "").trim();

    if (!token) return res.status(400).json({ error: "token_required" });
    if (!email) return res.status(400).json({ error: "email_required" });

    const db = getWebFirestore();
    const wAuth = getWebAuth();
    const now = new Date();

    const inviteSnap = await db
      .collection("invites")
      .where("token", "==", token)
      .where("email", "==", email)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (inviteSnap.empty) {
      return res.status(404).json({ error: "invite_not_found", message: "Invitación no válida o ya usada" });
    }

    const inviteDoc = inviteSnap.docs[0]!;
    const invite = inviteDoc.data();
    const companyId = String(invite.companyId ?? "");
    const accountId = String(invite.accountId ?? "");
    const roleId = String(invite.roleId ?? "");

    if (!companyId || !accountId) {
      return res.status(400).json({ error: "invite_data_invalid" });
    }

    let authUid: string;
    let generatedPassword: string | null = null;
    try {
      const userRecord = await wAuth.getUserByEmail(email);
      authUid = userRecord.uid;
    } catch {
      generatedPassword = password || Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      const newUser = await wAuth.createUser({
        email,
        displayName: displayName || undefined,
        password: generatedPassword,
        emailVerified: false,
      });
      authUid = newUser.uid;
    }

    const userRef = db.collection("users").doc(authUid);
    await userRef.set(
      {
        authUid,
        email,
        displayName,
        accountId,
        status: "active",
        webRoleIds: roleId ? [roleId] : [],
        webRoleNames: ["admin"],
        platform: ["web"],
        invitedAt: invite.createdAt || now,
        updatedAt: now,
        createdAt: now,
      },
      { merge: true }
    );

    const companyUserDocId = `${companyId}_${authUid}`;
    await db.collection("company-users").doc(companyUserDocId).set(
      {
        companyId,
        accountId,
        userId: authUid,
        userEmail: email,
        userDisplayName: displayName,
        webRoleIds: roleId ? [roleId] : [],
        webRoleNames: ["admin"],
        status: "active",
        createAt: now,
        updateAt: now,
        createBy: "invite-accept",
        updateBy: "invite-accept",
      },
      { merge: true }
    );

    await inviteDoc.ref.update({
      status: "accepted",
      acceptedAt: now,
      acceptedBy: authUid,
      updatedAt: now,
    });

    res.status(200).json(
      generatedPassword ? { ok: true, authUid, email, companyId, accountId, generatedPassword } : { ok: true, authUid, email, companyId, accountId }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/web/invites/accept POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


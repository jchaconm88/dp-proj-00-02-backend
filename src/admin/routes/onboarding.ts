import { Router } from "express";
import { getAdminFirestore, getWebAuth, getWebFirestore } from "../../lib/firebase-admin.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function generateAccountId(): string {
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

async function checkTaxIdUnique(taxId: string): Promise<boolean> {
  const db = getWebFirestore();
  const snap = await db.collection("companies").where("taxId", "==", taxId.trim()).limit(2).get();
  return snap.empty;
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
    platform: ["admin"],
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
      adminRoleIds: [adminRoleId],
      adminRoleNames: ["admin"],
      platform: ["admin"],
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );
}

const router = Router();

router.post("/start", async (_req, res) => {
  res.status(200).json({ ok: true });
});

router.get("/status", async (_req, res) => {
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

router.post("/complete", async (req, res) => {
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
    console.error("[admin/onboarding/complete] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/bootstrap-web-tenant", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const wDb = getWebFirestore();
    const wAuth = getWebAuth();
    const now = new Date();
    const companyId = String(req.body?.companyId ?? req.body?.id ?? "").trim();
    const name = String(req.body?.companyName ?? req.body?.name ?? "").trim();
    const webUserEmail = String(req.body?.webUserEmail ?? req.body?.firstUserEmail ?? "").trim().toLowerCase();
    const webUserDisplayName = String(req.body?.webUserDisplayName ?? req.body?.firstUserDisplayName ?? "").trim();
    const passwordFromClient = String(req.body?.password ?? "").trim();
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

    // Crear usuario en Firebase Auth para obtener uid
    let authUid: string;
    let generatedPassword: string | null = null;
    try {
      const userRecord = await wAuth.getUserByEmail(webUserEmail);
      authUid = userRecord.uid;
    } catch {
      generatedPassword =
        passwordFromClient ||
        Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      const newUser = await wAuth.createUser({
        email: webUserEmail,
        displayName: webUserDisplayName || undefined,
        password: generatedPassword,
        emailVerified: false,
      });
      authUid = newUser.uid;
    }

    const roleRef = wDb.collection("roles").doc();
    const userRef = wDb.collection("users").doc(authUid);
    const companyUserDocId = `${companyId}_${authUid}`;
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
      platform: ["web"],
      createdAt: now,
      updateAt: now,
      createBy: "admin",
      updateBy: "admin",
    });
    batch.set(
      userRef,
      {
        authUid,
        email: webUserEmail,
        displayName: webUserDisplayName,
        accountId,
        status: "active",
        webRoleIds: [roleRef.id],
        webRoleNames: ["admin"],
        platform: ["web"],
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    batch.set(memberRef, {
      companyId,
      accountId,
      userId: authUid,
      userEmail: webUserEmail,
      ...(webUserDisplayName ? { userDisplayName: webUserDisplayName } : {}),
      webRoleIds: [roleRef.id],
      webRoleNames: ["admin"],
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
      webUserId: authUid,
      webUserEmail,
      webRoleId: roleRef.id,
      companyUserDocId,
      ...(generatedPassword ? { generatedPassword } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/onboarding/bootstrap-web-tenant POST] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;


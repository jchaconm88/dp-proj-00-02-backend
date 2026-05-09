import { Router } from "express";
import { simpleRateLimit } from "../middlewares/rate-limit.js";
import { requireAdminAuth } from "../middlewares/admin-auth.js";
import { getAdminFirestore } from "../lib/firebase-admin.js";
import dashboardRouter from "./routes/dashboard.js";
import onboardingRouter from "./routes/onboarding.js";
import platformRouter from "./routes/platform/index.js";
import systemRouter from "./routes/system/index.js";
import webRouter from "./routes/web.js";

export const adminRouter = Router();

adminRouter.get("/healthz", (_req, res) => res.status(200).json({ ok: true, scope: "admin" }));

adminRouter.use(simpleRateLimit({ windowMs: 60_000, max: 600 }));
adminRouter.use(requireAdminAuth);

adminRouter.use("/dashboard", dashboardRouter);
adminRouter.use("/onboarding", onboardingRouter);
adminRouter.use("/platform", platformRouter);
adminRouter.use("/system", systemRouter);
adminRouter.use("/web", webRouter);

// Contexto del admin actual (uid/accountId/roles).
adminRouter.get("/me", async (req, res) => {
  try {
    const admin = (req as any).admin as
      | { uid?: string; email?: string | null; accountId?: string; adminRoleIds?: string[]; adminRoleNames?: string[] }
      | undefined;
    if (!admin?.uid) return res.status(401).json({ error: "unauthenticated" });
    const accountId = String(admin.accountId ?? "").trim();
    const hasAccount = Boolean(accountId) && accountId !== "pending";
    res.status(200).json({
      id: String(admin.uid),
      userId: String(admin.uid),
      accountId,
      email: admin.email ?? "",
      displayName: "",
      status: hasAccount ? "active" : "inactive",
      adminRoleIds: Array.isArray(admin.adminRoleIds) ? admin.adminRoleIds : [],
      adminRoleNames: Array.isArray(admin.adminRoleNames) ? admin.adminRoleNames : [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/me GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

/**
 * Asegura que exista el doc staff en Firestore Admin `users/{uid}`.
 * El docId siempre es el Firebase Auth UID.
 */
adminRouter.post("/users/me/upsert", async (req, res) => {
  try {
    const decoded = (req as any).auth as { uid?: string; email?: string; name?: string } | undefined;
    const uid = String(decoded?.uid ?? (req as any)?.admin?.uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated" });

    const email = String(decoded?.email ?? (req as any)?.admin?.email ?? "").trim().toLowerCase();
    const displayName = String(decoded?.name ?? "").trim();

    const db = getAdminFirestore();
    const now = new Date();

    const uidRef = db.collection("users").doc(uid);
    const uidSnap = await uidRef.get();

    await uidRef.set(
      {
        userId: uid,
        email,
        displayName,
        status: "active",
        adminRoleIds: [],
        adminRoleNames: [],
        platform: ["admin"],
        updatedAt: now,
        ...(uidSnap.exists ? {} : { createdAt: now }),
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, uid, email });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/users/me/upsert POST] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});


import type { RequestHandler } from "express";
import { getAdminAuth, getAdminFirestore } from "../lib/firebase-admin.js";

type AdminContext = {
  uid: string;
  email: string | null;
  accountId: string;
  adminRoleIds: string[];
  adminRoleNames: string[];
};

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

async function loadAdminUserContext(uid: string): Promise<AdminContext | null> {
  const db = getAdminFirestore();
  const direct = await db.collection("users").doc(uid).get();
  const pick = (data: FirebaseFirestore.DocumentData | undefined): AdminContext | null => {
    if (!data) return null;
    const status = String(data.status ?? "active").trim() === "inactive" ? "inactive" : "active";
    if (status !== "active") return null;
    const accountId = String(data.accountId ?? "").trim();
    if (!accountId) return null;
    return {
      uid,
      email: typeof data.email === "string" ? data.email : null,
      accountId,
      adminRoleIds: toStringArray(data.adminRoleIds),
      adminRoleNames: toStringArray(data.adminRoleNames),
    };
  };
  return pick(direct.exists ? direct.data() : undefined);
}

/**
 * Middleware de autenticación para rutas /admin/*.
 * Valida el Firebase ID Token contra el proyecto Admin.
 */
export const requireAdminAuth: RequestHandler = async (req, res, next) => {
  try {
    const header = String(req.header("authorization") ?? "").trim();
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "unauthenticated", reason: "missing_bearer_token" });
    const decoded = await getAdminAuth().verifyIdToken(token);
    (req as unknown as { auth?: unknown }).auth = decoded;
    const uid = String((decoded as any).uid ?? "").trim();
    if (!uid) return res.status(401).json({ error: "unauthenticated", reason: "missing_uid" });
    const ctx = await loadAdminUserContext(uid);
    if (!ctx) {
      // Crear usuario admin básico si no existe (registro inicial)
      const reqPath = String(req.path ?? "");
      if (reqPath.startsWith("/onboarding") || reqPath === "/me" || reqPath === "/users/me/upsert") {
        const db = getAdminFirestore();
        const now = new Date();
        const email = typeof (decoded as any).email === "string" ? String((decoded as any).email).trim().toLowerCase() : null;
        await db.collection("users").doc(uid).set(
          {
            userId: uid,
            email: email || "",
            displayName: "",
            status: "inactive",
            adminRoleIds: [],
            adminRoleNames: [],
            platform: ["admin"],
            createdAt: now,
            updatedAt: now,
          },
          { merge: true }
        );
        (req as unknown as { admin?: AdminContext }).admin = {
          uid,
          email,
          accountId: "pending",
          adminRoleIds: [],
          adminRoleNames: [],
        };
        return next();
      }
      return res.status(403).json({ error: "forbidden", reason: "missing_user_or_account" });
    }
    (req as unknown as { admin?: AdminContext }).admin = ctx;
    next();
  } catch (e) {
    const debug = process.env.AUTH_DEBUG === "1";
    const msg = e instanceof Error ? e.message : "verify_failed";
    // eslint-disable-next-line no-console
    console.error("[admin-auth] verifyIdToken failed:", msg);
    res.status(401).json({
      error: "unauthenticated",
      reason: "invalid_id_token",
      ...(debug ? { message: msg } : {}),
    });
  }
};

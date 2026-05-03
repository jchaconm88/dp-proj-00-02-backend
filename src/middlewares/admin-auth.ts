import type { RequestHandler } from "express";
import { getAdminAuth, getAdminFirestore } from "../lib/firebase-admin.js";

type AdminContext = {
  uid: string;
  email: string | null;
  accountId: string;
  roleIds: string[];
  roleNames: string[];
};

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

async function loadAdminUserContext(uid: string): Promise<AdminContext | null> {
  const db = getAdminFirestore();
  // Preferimos docId = uid, pero mantenemos fallback por `userId` para compatibilidad.
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
      roleIds: toStringArray(data.roleIds),
      roleNames: toStringArray(data.roleNames),
    };
  };
  const fromDirect = pick(direct.exists ? direct.data() : undefined);
  if (fromDirect) return fromDirect;

  const q = await db.collection("users").where("userId", "==", uid).limit(1).get();
  if (q.empty) return null;
  return pick(q.docs[0]?.data());
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
      // Permitir onboarding antes de que exista el doc `users` o `accountId`.
      if (String(req.path ?? "").startsWith("/onboarding")) {
        const accountId = String((req as any).body?.accountId ?? "").trim() || "pending";
        (req as unknown as { admin?: AdminContext }).admin = {
          uid,
          email: typeof (decoded as any).email === "string" ? String((decoded as any).email) : null,
          accountId,
          roleIds: [],
          roleNames: [],
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

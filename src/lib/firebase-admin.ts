import admin from "firebase-admin";
import fs from "node:fs";

let adminAuthApp: admin.app.App | null = null;
let webDataApp: admin.app.App | null = null;

function tryParseServiceAccountJson(raw: string | undefined): admin.ServiceAccount | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const projectId = String(parsed.project_id ?? "");
    const clientEmail = String(parsed.client_email ?? "");
    const privateKey = String(parsed.private_key ?? "");
    if (!projectId || !clientEmail || !privateKey) return null;
    return {
      projectId,
      clientEmail,
      privateKey,
    };
  } catch {
    return null;
  }
}

function tryReadServiceAccountFromFile(pathLike: string | undefined): admin.ServiceAccount | null {
  const p = String(pathLike ?? "").trim();
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return tryParseServiceAccountJson(raw);
  } catch {
    return null;
  }
}

/**
 * Firebase Admin App para el PROYECTO ADMIN (autenticación de empleados/admin).
 * Usa ADMIN_FIREBASE_PROJECT_ID + (opcional) ADMIN_FIREBASE_SERVICE_ACCOUNT_(PATH|JSON).
 */
export function getAdminAuthApp() {
  if (adminAuthApp) return adminAuthApp;
  const projectId = process.env.ADMIN_FIREBASE_PROJECT_ID;
  const sa =
    tryReadServiceAccountFromFile(process.env.ADMIN_FIREBASE_SERVICE_ACCOUNT_PATH) ??
    tryParseServiceAccountJson(process.env.ADMIN_FIREBASE_SERVICE_ACCOUNT_JSON);
  // eslint-disable-next-line no-console
  console.log(`[firebase-admin] Initializing "admin-auth" app (projectId=${projectId || sa?.projectId || "ADC-default"})`);
  adminAuthApp = admin.initializeApp(
    {
      projectId: projectId || sa?.projectId || undefined,
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault(),
    },
    "admin-auth"
  );
  return adminAuthApp;
}

/**
 * Firebase Admin App para el PROYECTO WEB (datos de clientes, Firestore, etc).
 * Usa WEB_FIREBASE_PROJECT_ID + (opcional) WEB_FIREBASE_SERVICE_ACCOUNT_(PATH|JSON).
 */
export function getWebDataApp() {
  if (webDataApp) return webDataApp;
  const projectId = process.env.WEB_FIREBASE_PROJECT_ID;
  const sa =
    tryReadServiceAccountFromFile(process.env.WEB_FIREBASE_SERVICE_ACCOUNT_PATH) ??
    tryParseServiceAccountJson(process.env.WEB_FIREBASE_SERVICE_ACCOUNT_JSON);
  // eslint-disable-next-line no-console
  console.log(`[firebase-admin] Initializing "web-data" app (projectId=${projectId || sa?.projectId || "ADC-default"})`);
  webDataApp = admin.initializeApp(
    {
      projectId: projectId || sa?.projectId || undefined,
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault(),
    },
    "web-data"
  );
  return webDataApp;
}

/** Auth del proyecto Admin (para verifyIdToken de empleados). */
export function getAdminAuth() {
  return getAdminAuthApp().auth();
}

/** Firestore del proyecto Admin (datos del panel admin: cuentas, roles, etc). */
export function getAdminFirestore() {
  return getAdminAuthApp().firestore();
}

/** Auth del proyecto Web (para verifyIdToken de clientes/usuarios web/mobile). */
export function getWebAuth() {
  return getWebDataApp().auth();
}

/** Firestore del proyecto Web (datos de la app: pedidos, clientes, etc). */
export function getWebFirestore() {
  return getWebDataApp().firestore();
}

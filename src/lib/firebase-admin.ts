import admin from "firebase-admin";
import fs from "node:fs";

let firebaseApp: admin.app.App | null = null;

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
 * Firebase Admin App (proyecto unificado por ambiente).
 *
 * Variables:
 * - FIREBASE_PROJECT_ID (opcional si el JSON trae `project_id`; en Cloud Run suele inferirse de GOOGLE_CLOUD_PROJECT)
 * - FIREBASE_STORAGE_BUCKET (opcional; default `{projectId}.firebasestorage.app`)
 * - FIREBASE_SERVICE_ACCOUNT_PATH (opcional)
 * - FIREBASE_SERVICE_ACCOUNT_JSON (opcional)
 *
 * Nota: mantenemos helpers `getAdmin*` y `getWeb*` por compatibilidad interna,
 * pero ambas rutas usan el mismo proyecto Firebase/GCP en el modelo unificado.
 */
export function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  const projectId = String(process.env.FIREBASE_PROJECT_ID ?? "").trim();
  const sa =
    tryReadServiceAccountFromFile(process.env.FIREBASE_SERVICE_ACCOUNT_PATH) ??
    tryParseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const resolvedProjectId =
    projectId ||
    sa?.projectId ||
    String(process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "").trim();
  const storageBucketExplicit = String(process.env.FIREBASE_STORAGE_BUCKET ?? "").trim();
  const storageBucket =
    storageBucketExplicit ||
    (resolvedProjectId ? `${resolvedProjectId}.firebasestorage.app` : undefined);
  if (!storageBucket) {
    throw new Error(
      "FIREBASE_STORAGE_BUCKET or FIREBASE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT on Cloud Run) is required for Storage"
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[firebase-admin] Initializing app (projectId=${resolvedProjectId || "ADC-default"}, storageBucket=${storageBucket})`
  );
  firebaseApp = admin.initializeApp(
    {
      projectId: resolvedProjectId || undefined,
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault(),
      storageBucket,
    },
    "firebase"
  );
  return firebaseApp;
}

/** Auth del proyecto Admin (para verifyIdToken de empleados). */
export function getAdminAuth() {
  return getFirebaseApp().auth();
}

/** Firestore del proyecto Admin (datos del panel admin: cuentas, roles, etc). */
export function getAdminFirestore() {
  return getFirebaseApp().firestore();
}

/** Auth del proyecto Web (para verifyIdToken de clientes/usuarios web/mobile). */
export function getWebAuth() {
  return getFirebaseApp().auth();
}

/** Firestore del proyecto Web (datos de la app: pedidos, clientes, etc). */
export function getWebFirestore() {
  return getFirebaseApp().firestore();
}

/** Storage del proyecto (Google Cloud Storage bucket por defecto). */
export function getWebStorage() {
  return getFirebaseApp().storage().bucket();
}

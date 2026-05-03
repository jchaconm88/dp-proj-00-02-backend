# dp-proj-00-02-backend

Backend (Cloud Run) basado en Express.

## Requisitos de Service Account (Cloud Run)

El backend correrá con una **Service Account** (recomendado: dedicada) y necesita permisos para operar sobre el proyecto Firebase de datos (`dp-proj-00-02-web`).

Roles típicos (mínimo razonable, ajusta según lo que active el backend):

- **Firestore (lectura/escritura)**: `roles/datastore.user`
- **Storage (leer/escribir/firmar URLs si aplica)**:
  - `roles/storage.objectAdmin` (lectura/escritura de objetos)
  - Si vas a generar **Signed URLs** server-side: `roles/iam.serviceAccountTokenCreator` sobre la misma SA
- **Firebase Auth (si el backend verifica tokens o maneja claims del proyecto web/admin)**:
  - `roles/firebaseauth.admin` (si usas Admin SDK para Auth; limita este rol solo si es necesario)
- **Secret Manager (si usas secretos en runtime)**: `roles/secretmanager.secretAccessor`
- **Logging (normalmente ya viene por defecto)**: `roles/logging.logWriter`

Recomendación: crear una SA por entorno (dev/stg/prod) y evitar usar la default compute/Cloud Run.

## Local

```bash
npm install
npm run dev
```

Healthcheck: `GET /healthz`

### Troubleshooting: `invalid_grant` / `invalid_rapt` (ADC)

Si al correr `npm run dev` ves un error tipo:

- `Getting metadata from plugin failed ... invalid_grant ... invalid_rapt`

Entonces tu backend está usando **ADC (Application Default Credentials)** (vía `google-auth-library` / `firebase-admin` con `applicationDefault()`) y tu sesión local de `gcloud` requiere reautenticación.

Fix rápido (documentado por ahora):

```bash
gcloud auth login --update-adc
```

Luego reinicia el backend (`npm run dev`).

## CORS + Cloud Run (muy importante para SPAs)

El Admin (browser) hace requests cross-origin (`localhost` → `run.app`) que disparan **preflight `OPTIONS`**.

- Si Cloud Run está con **`--no-allow-unauthenticated`**, el preflight puede fallar con **403 de Google IAM** antes de llegar a Express. El síntoma en el browser parece CORS (“no hay `Access-Control-Allow-Origin`”), pero la causa es **invoker/IAM**.
- Para MVP con validación por **Firebase ID token**, lo típico es **`--allow-unauthenticated`** + auth en app.

Variables:

- `CORS_ORIGINS`: lista separada por comas de orígenes permitidos (ej. `http://localhost:5173,https://<admin>.web.app`).
- Evita `CORS_ORIGINS="*"` si vas a combinarlo con `Access-Control-Allow-Credentials` (no es compatible en browsers).

### Alternativa en desarrollo (sin depender de CORS)

Puedes usar un **proxy del dev server** (Vite) para que el browser llame al mismo origin y el proxy reenvíe a Cloud Run. Ver `dp-proj-00-02-admin/README.md`.

## Firebase Admin SDK (AdminAuthProject) — credenciales correctas

Si tu Cloud Run vive en un **proyecto GCP distinto** al Firebase del Admin, es fácil terminar con **ADC** (Application Default Credentials) apuntando al proyecto equivocado y fallar `verifyIdToken` (401 `invalid_id_token`).

Opciones:

- **Recomendado (producción)**: montar el JSON de service account del **AdminAuthProject** como secreto y exponerlo como env var `ADMIN_FIREBASE_SERVICE_ACCOUNT_JSON` (string JSON completo).
- **Alternativa**: usar `GOOGLE_APPLICATION_CREDENTIALS` apuntando a un archivo (menos práctico en Cloud Run sin volúmenes).

Para acceso cross-project a Firestore del proyecto Web, típicamente necesitarás **otra** credencial/SA con permisos en ese proyecto, o una SA con roles cross-project. En este repo puedes usar `WEB_FIREBASE_SERVICE_ACCOUNT_JSON` (opcional) para inicializar explícitamente el app `web-data`.

Debug temporal:

- `AUTH_DEBUG=1` agrega `message` al JSON de error (útil en staging; evitar en prod si expones detalles).

## Docker (Cloud Run)

Build:

```bash
docker build -t dp-proj-00-02-backend .
```

### Importante: `gcloud run deploy --image ...:latest` NO reconstruye la imagen

Si cambias código TypeScript pero **no** vuelves a construir y publicar la imagen en Artifact Registry, Cloud Run puede seguir ejecutando un `dist/server.js` viejo (y verás CORS “como si no existiera”).

Flujo típico (Artifact Registry):

```bash
# 1) Build + push con un tag inmutable (recomendado)
docker build -t us-central1-docker.pkg.dev/<GCP_PROJECT>/<REPO>/dp-proj-00-02-backend:<GIT_SHA> .
docker push us-central1-docker.pkg.dev/<GCP_PROJECT>/<REPO>/dp-proj-00-02-backend:<GIT_SHA>

# 2) Deploy apuntando al tag (no solo :latest)
gcloud run deploy dp-proj-00-02-backend ^
  --image us-central1-docker.pkg.dev/<GCP_PROJECT>/<REPO>/dp-proj-00-02-backend:<GIT_SHA> ^
  --region us-central1
```

Alternativa (sin Docker local):

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/<GCP_PROJECT>/<REPO>/dp-proj-00-02-backend:<GIT_SHA>
```

Run:

```bash
docker run -p 8080:8080 -e PORT=8080 dp-proj-00-02-backend
```


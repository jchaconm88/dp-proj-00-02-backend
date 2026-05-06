# dp-proj-00-02-backend

Backend (Cloud Run) basado en Express.

**Infraestructura:** se define en **`dp-proj-00-02-infra`** (Terraform): un **proyecto GCP por ambiente** (`dev` / `qa` / `prd`) que incluye Cloud Run, Artifact Registry, Firestore, Auth y Hosting. El `project_id` concreto lo emiten los outputs de Terraform (sin IDs fijos en este README). En local, copia valores desde el Environment o desde `terraform output`.

## Requisitos de Service Account (Cloud Run)

El backend en Cloud Run usa la **SA runtime** creada por Terraform en el **mismo** `project_id` del ambiente (Firestore, Storage, Auth en ese proyecto). En local puedes seguir usando JSON por `ADMIN_FIREBASE_*` / `WEB_*` si no usas solo ADC.

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

### Requisitos

- Node.js (LTS)
- npm
- (Opcional) `gcloud` si vas a usar **ADC** en vez de JSON

### Paso a paso

1) Instala dependencias:

```bash
npm install
```

2) Crea tu `.env` desde el ejemplo:

- Copia `./.env.example` a `./.env`
- Define al menos:
  - `PORT` (default `8080`)
  - `CORS_ORIGINS` (por ejemplo `http://localhost:5173,http://localhost:5174`)
  - `FIREBASE_PROJECT_ID` (output `project_id` del ambiente en `dp-proj-00-02-infra`)

3) Credenciales Firebase Admin SDK (elige una)

- **Opción A (recomendada para dev local):** JSON de Service Account
  - Descarga un JSON (temporal) del SA runtime del ambiente, o crea uno de dev con permisos mínimos.
  - Configura `FIREBASE_SERVICE_ACCOUNT_PATH` apuntando al archivo.

- **Opción B:** ADC (Application Default Credentials)
  - Inicia sesión y actualiza ADC:

```bash
gcloud auth login --update-adc
```

4) Levanta el backend:

```bash
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

- `CORS_ORIGINS`: orígenes permitidos separados por **coma** o **`|`** (ej. `http://localhost:5173,https://<admin>.web.app`). En GitHub puedes seguir usando comas: el workflow las convierte a `|` al llamar a `gcloud`.
- Evita `CORS_ORIGINS="*"` si vas a combinarlo con `Access-Control-Allow-Credentials` (no es compatible en browsers).

### Alternativa en desarrollo (sin depender de CORS)

Puedes usar un **proxy del dev server** (Vite) para que el browser llame al mismo origin y el proxy reenvíe a Cloud Run. Ver `dp-proj-00-02-admin/README.md`.

## Firebase Admin SDK (AdminAuthProject) — credenciales correctas

En el modelo **unificado por ambiente**, Admin Auth y datos Web comparten el mismo **Firebase/GCP project**.

- En Cloud Run lo habitual es **ADC** con la SA runtime (sin JSON extra).
- En local, usa `FIREBASE_SERVICE_ACCOUNT_PATH` o `FIREBASE_SERVICE_ACCOUNT_JSON` (recomendado) o ADC.

Debug temporal:

- `AUTH_DEBUG=1` agrega `message` al JSON de error (útil en staging; evitar en prod si expones detalles).

## CI (GitHub Actions)

Workflow: `.github/workflows/deploy-cloud-run.yml`.

1. **Build** Node + Docker.
2. **Deploy** Cloud Run con `--source` al **GitHub Environment** (`dev` / `qa` / `prd`) seleccionado.

Terraform vive en **`dp-proj-00-02-infra`** (no en este repo). Tras `terraform apply`, sincronizad outputs a variables del Environment (`sync-github-env.sh` o a mano).

**Secrets / variables por Environment:**

| Nombre | Tipo | Uso |
|--------|------|-----|
| `GCP_SERVICE_ACCOUNT` | Secret | JSON de **`github-deploy-backend@…`** (creada por infra en ese `project_id`). |
| `GCP_PROJECT_ID` | Variable | Output `project_id` del stack Terraform. |
| `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT` | Variable | Email de la SA runtime del stack. |
| `CLOUD_RUN_SERVICE_NAME` | Variable | Opcional; por defecto `dp-proj-00-02-backend`. |
| `CORS_ORIGINS` | Variable | **Orígenes del Admin/Web en producción** (coma o `|`). Ej. `https://...-adm.firebaseapp.com,https://...-adm.web.app`. El deploy convierte comas a `|` para `gcloud` (las comas rompen `--update-env-vars`). Sin esto, Cloud Run usa el default de `server.ts` (solo localhost). |
| `DEPLOY_ENVIRONMENT` | Variable (repo) | Si no usáis `workflow_dispatch`, entorno por defecto para pushes a `main` (p. ej. `dev`). |

## Docker (Cloud Run)

Build:

```bash
docker build -t dp-proj-00-02-backend .
```

### Importante: `gcloud run deploy --image ...:latest` NO reconstruye la imagen

Si cambias código TypeScript pero **no** vuelves a construir y publicar la imagen en Artifact Registry, Cloud Run puede seguir ejecutando un `dist/server.js` viejo (y verás CORS “como si no existiera”).

Flujo típico (Artifact Registry):

```bash
# Sustituye <GCP_PROJECT_ID> y región por los del ambiente (outputs de dp-proj-00-02-infra).
# 1) Build + push con un tag inmutable (recomendado)
docker build -t us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/dp-repo/dp-proj-00-02-backend:<GIT_SHA> .
docker push us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/dp-repo/dp-proj-00-02-backend:<GIT_SHA>

# 2) Deploy apuntando al tag (no solo :latest)
gcloud run deploy dp-proj-00-02-backend ^
  --image us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/dp-repo/dp-proj-00-02-backend:<GIT_SHA> ^
  --region us-central1 ^
  --project <GCP_PROJECT_ID>
```

Alternativa (sin Docker local):

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/<GCP_PROJECT_ID>/dp-repo/dp-proj-00-02-backend:<GIT_SHA> --project <GCP_PROJECT_ID>
```

Run:

```bash
docker run -p 8080:8080 -e PORT=8080 dp-proj-00-02-backend
```


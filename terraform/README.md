# Terraform — backend (GCP) — **histórico / deprecado**

> **La fuente de verdad de Terraform es [`dp-proj-00-02-infra`](../../dp-proj-00-02-infra/README.md)** (proyecto unificado por ambiente: dev / qa / prd). **No uses este directorio para nuevos applies** salvo migración o consulta del modelo anterior (tres proyectos GCP + IAM cross-project).

---

Define APIs, Artifact Registry, **service accounts** e **IAM** (incluido cross-project hacia datos web y Auth admin). **Patrón legacy** antes de centralizar en `dp-proj-00-02-infra`.

## Proyecto seed (`dp-proj-00-02-seed`)

Recomendado: un proyecto solo para **estado Terraform** + **SA bootstrap** (la que autentica `terraform apply` en CI). Así no mezclas estado ni poderes de bootstrap con workloads.

### Opción A — Script (recomendado)

En **Cloud Shell** (o bash con `gcloud` configurado y cuenta con permiso para crear proyectos / IAM):

```bash
export BILLING_ACCOUNT_ID="XXXXXX-XXXXXX-XXXXXX"   # gcloud billing accounts list
chmod +x terraform/scripts/bootstrap-seed.sh      # desde la raíz del repo backend
./terraform/scripts/bootstrap-seed.sh
```

Variables opcionales (por defecto coinciden con este repo):

| Variable | Default |
|----------|---------|
| `PROJECT_SEED` | `dp-proj-00-02-seed` |
| `PROJECT_BACKEND` | `dp-proj-00-02-backend-q` |
| `PROJECT_WEB` | `layout-admin` |
| `PROJECT_ADMIN` | `dp-proj-00-02-admin-q` |
| `TF_STATE_BUCKET` | `${PROJECT_SEED}-tfstate` |
| `TF_STATE_REGION` | `us-central1` |

El script: crea proyecto seed, facturación, APIs, bucket con versionado, SA `terraform-bootstrap@…`, IAM sobre el bucket, **Owner** de la SA bootstrap en backend + web + admin (MVP), y genera `terraform-bootstrap-key.json`.

Luego en GitHub del repo **backend**:

1. Secret **`GCP_TERRAFORM_SA_KEY`** ← contenido del JSON generado.
2. Variable **`TF_STATE_BUCKET`** ← nombre del bucket (sin `gs://`), p. ej. `dp-proj-00-02-seed-tfstate`.
3. Borra el JSON en disco.

### Opción B — Comandos manuales (mismo resultado)

Sustituye `BILLING`, IDs de proyecto y `BUCKET` si hace falta.

```bash
export PROJECT_SEED="dp-proj-00-02-seed"
export BUCKET="${PROJECT_SEED}-tfstate"
export REGION="us-central1"
export PROJECT_BACKEND="dp-proj-00-02-backend-q"
export PROJECT_WEB="layout-admin"
export PROJECT_ADMIN="dp-proj-00-02-admin-q"
export BOOTSTRAP_SA="terraform-bootstrap@${PROJECT_SEED}.iam.gserviceaccount.com"
export BILLING_ACCOUNT_ID="TU_BILLING_ACCOUNT_ID"

gcloud projects create "${PROJECT_SEED}" --name="dp-proj-00-02 seed"
gcloud billing projects link "${PROJECT_SEED}" --billing-account="${BILLING_ACCOUNT_ID}"

gcloud services enable storage.googleapis.com serviceusage.googleapis.com \
  --project="${PROJECT_SEED}"

gcloud storage buckets create "gs://${BUCKET}" \
  --project="${PROJECT_SEED}" \
  --location="${REGION}" \
  --uniform-bucket-level-access

gcloud storage buckets update "gs://${BUCKET}" --versioning --project="${PROJECT_SEED}"

gcloud iam service-accounts create terraform-bootstrap \
  --project="${PROJECT_SEED}" \
  --display-name="Terraform bootstrap"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project="${PROJECT_SEED}" \
  --member="serviceAccount:${BOOTSTRAP_SA}" \
  --role="roles/storage.objectAdmin"

for p in "${PROJECT_BACKEND}" "${PROJECT_WEB}" "${PROJECT_ADMIN}"; do
  gcloud projects add-iam-policy-binding "${p}" \
    --member="serviceAccount:${BOOTSTRAP_SA}" \
    --role="roles/owner"
done

gcloud iam service-accounts keys create terraform-bootstrap-key.json \
  --iam-account="${BOOTSTRAP_SA}" \
  --project="${PROJECT_SEED}"
```

Si tu organización **obliga carpeta** al crear proyectos:

```bash
gcloud projects create "${PROJECT_SEED}" --folder=FOLDER_ID --name="..."
```

## Huevo y gallina (resumen)

Terraform no puede crearse a sí mismo: hace falta **una** identidad inicial (usuario o SA bootstrap) con IAM suficiente. El seed + script anterior cubren eso.

Después del primer `terraform apply`:

1. Genera clave JSON de **`github-deploy-backend@dp-proj-00-02-backend-q.iam.gserviceaccount.com`** (creada por Terraform).
2. Súbela al secret **`GCP_SERVICE_ACCOUNT`** (job de Cloud Run).

Mejora recomendada: **Workload Identity Federation** para no depender de claves JSON.

## Primer `terraform apply` (local o CI)

```bash
cd terraform
terraform init \
  -backend-config="bucket=TU_BUCKET_SIN_GS" \
  -backend-config="prefix=terraform/backend"

export GOOGLE_APPLICATION_CREDENTIALS=/ruta/terraform-bootstrap-key.json

terraform plan
terraform apply
```

Variable GitHub **`TF_STATE_BUCKET`** = mismo nombre de bucket (p. ej. `dp-proj-00-02-seed-tfstate`).

## Imports si ya creaste recursos a mano

```bash
terraform import google_artifact_registry_repository.docker projects/dp-proj-00-02-backend-q/locations/us-central1/repositories/dp-repo
terraform import google_service_account.runtime projects/dp-proj-00-02-backend-q/serviceAccounts/dp-proj-00-02-backend-sa@dp-proj-00-02-backend-q.iam.gserviceaccount.com
```

## Salidas útiles

Tras `apply`:

- `runtime_service_account_email` → opcional en GitHub `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`.
- `github_deploy_service_account_email` → clave → secret `GCP_SERVICE_ACCOUNT`.

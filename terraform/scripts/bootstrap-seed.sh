#!/usr/bin/env bash
# =============================================================================
# DEPRECADO para nuevos entornos: usar dp-proj-00-02-infra/terraform/scripts/bootstrap-seed.sh
# (proyecto unificado por ambiente). Este script conserva el flujo legacy (seed + Owner en
# backend/web/admin separados).
# =============================================================================
# Bootstrap del proyecto SEED: proyecto GCP, bucket de estado Terraform,
# SA "terraform-bootstrap" y permisos para que GitHub (secret GCP_TERRAFORM_SA_KEY)
# pueda ejecutar terraform apply sobre backend + web + admin.
#
# Ejecutar en: Cloud Shell, WSL, Git Bash o macOS/Linux con gcloud instalado.
# Revisa y exporta BILLING_ACCOUNT_ID antes (gcloud billing accounts list).
#
# AVISO: otorga roles/owner a la SA bootstrap en 3 proyectos (MVP). Restringe
# roles después del primer apply exitoso.
# =============================================================================
set -euo pipefail

# --- IDs de proyecto (ajusta si difieren) ---
export PROJECT_SEED="${PROJECT_SEED:-dp-proj-00-02-seed}"
export PROJECT_BACKEND="${PROJECT_BACKEND:-dp-proj-00-02-backend-q}"
export PROJECT_WEB="${PROJECT_WEB:-layout-admin}"
export PROJECT_ADMIN="${PROJECT_ADMIN:-dp-proj-00-02-admin-q}"

# Bucket globalmente único; si existe error "already exists", cambia el nombre.
export TF_STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT_SEED}-tfstate}"
export TF_STATE_REGION="${TF_STATE_REGION:-us-central1}"

export BOOTSTRAP_SA_ID="${BOOTSTRAP_SA_ID:-terraform-bootstrap}"
export BOOTSTRAP_SA_EMAIL="${BOOTSTRAP_SA_ID}@${PROJECT_SEED}.iam.gserviceaccount.com"

if [[ -z "${BILLING_ACCOUNT_ID:-}" ]]; then
  echo "ERROR: exporta BILLING_ACCOUNT_ID con el ID de facturación (ej. 012345-6789AB-CDEF01)."
  echo "  gcloud billing accounts list"
  exit 1
fi

echo "==> 1) Crear proyecto seed (ignora error si ya existe)"
gcloud projects create "${PROJECT_SEED}" \
  --name="dp-proj-00-02 seed (Terraform / estado)" \
  2>/dev/null || echo "    (proyecto ya existía)"

echo "==> 2) Vincular facturación al seed (ignora si ya estaba vinculado)"
gcloud billing projects link "${PROJECT_SEED}" --billing-account="${BILLING_ACCOUNT_ID}" \
  2>/dev/null || echo "    (facturación ya vinculada o error; revisa con: gcloud billing projects describe ${PROJECT_SEED})"

echo "==> 3) APIs en el proyecto seed"
gcloud services enable storage.googleapis.com serviceusage.googleapis.com \
  --project="${PROJECT_SEED}"

echo "==> 4) Crear bucket de estado Terraform (uniform access + versionado)"
# Crear bucket (si el nombre global ya existe, define otro TF_STATE_BUCKET y vuelve a ejecutar)
gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
  --project="${PROJECT_SEED}" \
  --location="${TF_STATE_REGION}" \
  --uniform-bucket-level-access \
  2>/dev/null || echo "    (bucket ya existía; comprobando versionado)"

gcloud storage buckets update "gs://${TF_STATE_BUCKET}" \
  --versioning \
  --project="${PROJECT_SEED}"

echo "==> 5) SA terraform-bootstrap en el proyecto seed"
gcloud iam service-accounts create "${BOOTSTRAP_SA_ID}" \
  --project="${PROJECT_SEED}" \
  --display-name="Terraform bootstrap (GitHub Actions)" \
  2>/dev/null || echo "    (SA ya existía)"

echo "==> 6) La SA bootstrap puede leer/escribir el estado en ESE bucket"
gcloud storage buckets add-iam-policy-binding "gs://${TF_STATE_BUCKET}" \
  --project="${PROJECT_SEED}" \
  --member="serviceAccount:${BOOTSTRAP_SA_EMAIL}" \
  --role="roles/storage.objectAdmin"

echo "==> 7) Permisos cross-project (MVP: Owner — restringe después)"
for p in "${PROJECT_BACKEND}" "${PROJECT_WEB}" "${PROJECT_ADMIN}"; do
  echo "    -- ${p}"
  gcloud projects add-iam-policy-binding "${p}" \
    --member="serviceAccount:${BOOTSTRAP_SA_EMAIL}" \
    --role="roles/owner" \
    2>/dev/null || echo "    (binding ya existía o sin permiso en ${p})"
done

echo "==> 8) Clave JSON para GitHub secret GCP_TERRAFORM_SA_KEY"
KEY_OUT="${KEY_OUT:-./terraform-bootstrap-key.json}"
gcloud iam service-accounts keys create "${KEY_OUT}" \
  --iam-account="${BOOTSTRAP_SA_EMAIL}" \
  --project="${PROJECT_SEED}"

echo ""
echo "-------------------------------------------------------------------"
echo "Listo."
echo "  1) Sube el contenido de ${KEY_OUT} al secret GitHub: GCP_TERRAFORM_SA_KEY"
echo "  2) Variable de repo TF_STATE_BUCKET = ${TF_STATE_BUCKET}"
echo "  3) Borra el archivo local de la clave cuando termines: rm -f ${KEY_OUT}"
echo "  4) Tras el primer terraform apply, crea clave de github-deploy-backend@..."
echo "     y súbela a GCP_SERVICE_ACCOUNT (ver terraform/README.md)"
echo "-------------------------------------------------------------------"

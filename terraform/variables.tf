variable "backend_project_id" {
  type        = string
  description = "Proyecto GCP donde viven Cloud Run, Artifact Registry y las SA del backend."
  default     = "dp-proj-00-02-backend-q"
}

variable "web_data_project_id" {
  type        = string
  description = "Proyecto Firebase/GCP donde está Firestore/Storage del producto web (p. ej. layout-admin)."
  default     = "layout-admin"
}

variable "admin_firebase_project_id" {
  type        = string
  description = "Proyecto Firebase del Admin (Auth Admin SDK, etc.)."
  default     = "dp-proj-00-02-admin-q"
}

variable "region" {
  type        = string
  description = "Región de Artifact Registry y Cloud Run."
  default     = "us-central1"
}

variable "artifact_repository_id" {
  type        = string
  description = "Id del repositorio Artifact Registry (formato DOCKER)."
  default     = "dp-repo"
}

variable "runtime_service_account_id" {
  type        = string
  description = "account_id de la SA que ejecutará el contenedor en Cloud Run."
  default     = "dp-proj-00-02-backend-sa"
}

variable "github_deploy_service_account_id" {
  type        = string
  description = "account_id de la SA usada por GitHub Actions para `gcloud run deploy --source`."
  default     = "github-deploy-backend"
}

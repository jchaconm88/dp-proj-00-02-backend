output "runtime_service_account_email" {
  description = "Pasar a Cloud Run como --service-account y a vars.CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT en GitHub."
  value       = google_service_account.runtime.email
}

output "github_deploy_service_account_email" {
  description = "Crear clave JSON de esta SA y guardarla en el secret GCP_SERVICE_ACCOUNT de GitHub (o migrar a WIF)."
  value       = google_service_account.github_deploy.email
}

output "artifact_registry_url" {
  description = "Prefijo para tags de imagen."
  value       = "${var.region}-docker.pkg.dev/${var.backend_project_id}/${var.artifact_repository_id}"
}

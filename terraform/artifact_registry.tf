resource "google_artifact_registry_repository" "docker" {
  depends_on = [google_project_service.backend]

  location      = var.region
  project       = var.backend_project_id
  repository_id = var.artifact_repository_id
  description   = "Imágenes Docker del backend (Terraform)"
  format        = "DOCKER"
}

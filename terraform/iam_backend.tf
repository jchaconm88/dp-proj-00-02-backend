# Permisos en el proyecto del backend para la SA que ejecuta el deploy desde GitHub.

locals {
  github_deploy_project_roles = [
    "roles/run.admin",
    "roles/cloudbuild.builds.editor",
    "roles/storage.admin",
    "roles/artifactregistry.writer",
    "roles/serviceusage.serviceUsageConsumer",
  ]
}

resource "google_project_iam_member" "github_deploy_roles" {
  for_each = toset(local.github_deploy_project_roles)

  project = var.backend_project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_service_account_iam_member" "github_deploy_can_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}

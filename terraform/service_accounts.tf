resource "google_service_account" "runtime" {
  depends_on = [google_project_service.backend]

  project      = var.backend_project_id
  account_id   = var.runtime_service_account_id
  display_name = "dp-proj-00-02 backend (runtime Cloud Run)"
}

resource "google_service_account" "github_deploy" {
  depends_on = [google_project_service.backend]

  project      = var.backend_project_id
  account_id   = var.github_deploy_service_account_id
  display_name = "GitHub Actions — deploy Cloud Run backend"
}

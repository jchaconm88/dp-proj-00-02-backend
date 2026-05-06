locals {
  backend_apis = [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
  ]
}

resource "google_project_service" "backend" {
  for_each = toset(local.backend_apis)

  project            = var.backend_project_id
  service            = each.value
  disable_on_destroy = false
}

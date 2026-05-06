# La SA runtime vive en backend_project_id pero accede a datos en otros proyectos.

resource "google_project_iam_member" "runtime_web_datastore" {
  project = var.web_data_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_web_storage" {
  project = var.web_data_project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_admin_firebaseauth" {
  project = var.admin_firebase_project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

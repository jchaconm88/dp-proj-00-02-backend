terraform {
  required_version = ">= 1.6"

  # Estado remoto (obligatorio en CI). Crea el bucket una vez (ver README en esta carpeta).
  backend "gcs" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.40.0, < 7.0.0"
    }
  }
}

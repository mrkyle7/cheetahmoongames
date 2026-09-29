# ---------------------------------------------------------------------------
# Shared by every game: APIs, the Docker image registry and a data bucket.
# ---------------------------------------------------------------------------

resource "google_project_service" "secretmanager" {
  project            = var.project_name
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudrun" {
  project            = var.project_name
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "docker_us" {
  project       = var.project_name
  location      = var.region
  repository_id = "docker-us"
  description   = "Docker images for bartenders"
  format        = "DOCKER"

  labels = {
    env    = var.env
    region = var.region
    app    = var.app_name
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  cleanup_policies {
    id     = "delete-old-tagged"
    action = "DELETE"
    condition {
      tag_state  = "TAGGED"
      older_than = "2592000s" # 30 days
    }
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
}

resource "google_storage_bucket" "data" {
  name     = var.bucket_name
  location = var.region
  project  = var.project_name

  labels = {
    env       = var.env
    region    = var.region
    app       = var.app_name
    sensitive = "false"
  }
}

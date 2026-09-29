# One game: a public Cloud Run service at <subdomain>.<domain>, deployed from
# its own GitHub repo. See ADDING_A_GAME.md at the repo root.

locals {
  host = "${var.subdomain}.${var.domain}"
}

# --- Running ------------------------------------------------------------------

resource "google_service_account" "run" {
  project      = var.project
  account_id   = "${var.name}-run"
  display_name = "Cloud Run service account for ${var.name}"
}

# The game's own image registry, so no other game can overwrite its images.
resource "google_artifact_registry_repository" "images" {
  project       = var.project
  location      = var.region
  repository_id = var.name
  description   = "Docker images for ${var.name}"
  format        = "DOCKER"

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

resource "google_artifact_registry_repository_iam_member" "run_pulls_images" {
  project    = var.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.run.email}"
}

resource "google_cloud_run_v2_service" "this" {
  project             = var.project
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.run.email

    timeout                          = var.timeout
    session_affinity                 = var.session_affinity
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      # Placeholder until the game's own workflow deploys its image. Later
      # image changes come from those deploys, so terraform ignores them.
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_artifact_registry_repository_iam_member.run_pulls_images,
  ]
}

resource "google_cloud_run_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.this.project
  location = google_cloud_run_v2_service.this.location
  service  = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_domain_mapping" "this" {
  project  = var.project
  location = var.region
  name     = local.host

  metadata {
    namespace = var.project
  }

  spec {
    route_name = google_cloud_run_v2_service.this.name
  }
}

# Subdomain mappings are always served through ghs.googlehosted.com.
resource "google_dns_record_set" "cname" {
  project      = var.project
  name         = "${local.host}."
  type         = "CNAME"
  ttl          = 300
  managed_zone = var.dns_zone
  rrdatas      = ["ghs.googlehosted.com."]
}

# --- Deploying: the game's own repo only ----------------------------------------
#
# The game's workflow acts as this account. It can push to this game's
# registry and deploy new revisions of this game's service, nothing else.

resource "google_service_account" "deploy" {
  project      = var.project
  account_id   = "${var.name}-deploy"
  display_name = "GitHub Actions deploys for ${var.name}"
}

resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${var.github_pool_name}/attribute.repository/${var.github_repo}"
}

resource "google_cloud_run_v2_service_iam_member" "deploy_developer" {
  project  = google_cloud_run_v2_service.this.project
  location = google_cloud_run_v2_service.this.location
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deploy.email}"
}

# Read-only, so the workflow can list revisions when rolling back.
resource "google_project_iam_member" "deploy_run_viewer" {
  project = var.project
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# New revisions run as the game's runtime account.
resource "google_service_account_iam_member" "deploy_acts_as_run" {
  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_artifact_registry_repository_iam_member" "deploy_pushes_images" {
  project    = var.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

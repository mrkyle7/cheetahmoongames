# One game: a public Cloud Run service at <subdomain>.<domain>, deployed from
# its own GitHub repo. See ADDING_A_GAME.md at the repo root.

locals {
  host = "${var.subdomain}.${var.domain}"
}

resource "google_service_account" "run" {
  project      = var.project
  account_id   = "${var.name}-run"
  display_name = "Cloud Run service account for ${var.name}"
}

# The CI account deploys revisions that run as this account.
resource "google_service_account_iam_member" "ci_acts_as_run" {
  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.ci_service_account}"
}

resource "google_artifact_registry_repository_iam_member" "run_pulls_images" {
  project    = var.project
  location   = var.registry_location
  repository = var.registry_name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.run.email}"
}

# The game's repo may deploy through the CI account.
resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = "projects/${var.project}/serviceAccounts/${var.ci_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${var.github_pool_name}/attribute.repository/${var.github_repo}"
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
    google_service_account_iam_member.ci_acts_as_run,
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

# ---------------------------------------------------------------------------
# cheetahmoongames.com — the games home page (site/ in this repo).
# Also redirects Bartenders' old URLs on this domain to its subdomain.
# ---------------------------------------------------------------------------

resource "google_service_account" "site_run" {
  project      = var.project_name
  account_id   = "cheetahmoongames-run"
  display_name = "Cloud Run service account for the cheetahmoongames.com home page"
}

resource "google_service_account_iam_member" "ci_impersonates_site_run_sa" {
  service_account_id = google_service_account.site_run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.ci_service_account}"
}

resource "google_artifact_registry_repository_iam_member" "site_run_pulls_images" {
  project    = var.project_name
  location   = google_artifact_registry_repository.docker_us.location
  repository = google_artifact_registry_repository.docker_us.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.site_run.email}"
}

resource "google_cloud_run_v2_service" "site" {
  project             = var.project_name
  name                = "cheetahmoongames"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.site_run.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      # Replaced by the real image when the workflow deploys site/.
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "BARTENDERS_URL"
        value = "https://${local.bartenders_host}"
      }

      # Moves Bartenders' old host-only login cookies onto the shared domain.
      env {
        name  = "COOKIE_DOMAIN"
        value = var.domain_name
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
    google_project_service.cloudrun,
    google_artifact_registry_repository_iam_member.site_run_pulls_images,
  ]
}

resource "google_cloud_run_service_iam_member" "site_public" {
  project  = google_cloud_run_v2_service.site.project
  location = google_cloud_run_v2_service.site.location
  service  = google_cloud_run_v2_service.site.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Domain -------------------------------------------------------------------

resource "google_cloud_run_domain_mapping" "cheetahmoongames" {
  project  = var.project_name
  location = var.region
  name     = var.domain_name

  metadata {
    namespace = var.project_name
  }

  spec {
    route_name = google_cloud_run_v2_service.site.name
  }
}

resource "google_dns_record_set" "cheetahmoongames_a" {
  project      = var.project_name
  name         = "${var.domain_name}."
  type         = "A"
  ttl          = 300
  managed_zone = "cheetahmoongames-com"

  rrdatas = distinct([
    for r in google_cloud_run_domain_mapping.cheetahmoongames.status[0].resource_records :
    r.rrdata if r.type == "A"
  ])
}

resource "google_dns_record_set" "cheetahmoongames_aaaa" {
  project      = var.project_name
  name         = "${var.domain_name}."
  type         = "AAAA"
  ttl          = 300
  managed_zone = "cheetahmoongames-com"

  rrdatas = distinct([
    for r in google_cloud_run_domain_mapping.cheetahmoongames.status[0].resource_records :
    r.rrdata if r.type == "AAAA"
  ])
}

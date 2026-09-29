# ---------------------------------------------------------------------------
# Bartenders of Corfu — bartenders.cheetahmoongames.com
# Deployed by mrkyle7/bartenders-of-corfu (image: docker-us/bartenders).
# Supabase is external; its URL/key and the VAPID keys live in Secret Manager.
# ---------------------------------------------------------------------------

resource "google_service_account" "bartenders_run" {
  project      = var.project_name
  account_id   = "bartenders-run"
  display_name = "Cloud Run service account for bartenders"
}

resource "google_service_account_iam_member" "ci_impersonates_run_sa" {
  service_account_id = google_service_account.bartenders_run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.ci_service_account}"
}

# --- Secrets ------------------------------------------------------------------

resource "google_secret_manager_secret" "vapid_private_key" {
  project   = var.project_name
  secret_id = "vapid-private-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "vapid_public_key" {
  project   = var.project_name
  secret_id = "vapid-public-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "supabase_url" {
  project   = var.project_name
  secret_id = "supabase-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "supabase_key" {
  project   = var.project_name
  secret_id = "supabase-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

# Cloud Run reads secrets at container start
resource "google_secret_manager_secret_iam_member" "run_reads_vapid_private" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.vapid_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bartenders_run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_reads_vapid_public" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.vapid_public_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bartenders_run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_reads_url" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bartenders_run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_reads_key" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bartenders_run.email}"
}

# CI reads current value (to diff) and adds new versions on deploy
resource "google_secret_manager_secret_iam_member" "ci_reads_url" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.ci_service_account}"
}

resource "google_secret_manager_secret_iam_member" "ci_reads_key" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.ci_service_account}"
}

resource "google_secret_manager_secret_iam_member" "ci_writes_url" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_url.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${var.ci_service_account}"
}

resource "google_secret_manager_secret_iam_member" "ci_writes_key" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.supabase_key.secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${var.ci_service_account}"
}

resource "google_secret_manager_secret_iam_member" "ci_reads_vapid_private" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.vapid_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.ci_service_account}"
}

resource "google_secret_manager_secret_iam_member" "ci_reads_vapid_public" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.vapid_public_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.ci_service_account}"
}

# --- Service ------------------------------------------------------------------

resource "google_artifact_registry_repository_iam_member" "run_pulls_images" {
  project    = var.project_name
  location   = google_artifact_registry_repository.docker_us.location
  repository = google_artifact_registry_repository.docker_us.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.bartenders_run.email}"
}

resource "google_cloud_run_v2_service" "bartenders" {
  project             = var.project_name
  name                = "bartenders"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  scaling {
    min_instance_count = 0
  }

  template {
    service_account = google_service_account.bartenders_run.email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name = "SUPABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.supabase_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SUPABASE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.supabase_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "VAPID_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.vapid_private_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "VAPID_PUBLIC_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.vapid_public_key.secret_id
            version = "latest"
          }
        }
      }

      # Share the login cookie across the apex and all subdomains, so a login
      # carries over (see app/auth_cookie.py).
      env {
        name  = "COOKIE_DOMAIN"
        value = var.domain_name
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      scaling,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.cloudrun,
    google_secret_manager_secret_iam_member.run_reads_url,
    google_secret_manager_secret_iam_member.run_reads_key,
    google_secret_manager_secret_iam_member.run_reads_vapid_private,
    google_secret_manager_secret_iam_member.run_reads_vapid_public,
    google_artifact_registry_repository_iam_member.run_pulls_images,
  ]
}

resource "google_cloud_run_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.bartenders.project
  location = google_cloud_run_v2_service.bartenders.location
  service  = google_cloud_run_v2_service.bartenders.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Domain -------------------------------------------------------------------

resource "google_cloud_run_domain_mapping" "bartenders" {
  project  = var.project_name
  location = var.region
  name     = local.bartenders_host

  metadata {
    namespace = var.project_name
  }

  spec {
    route_name = google_cloud_run_v2_service.bartenders.name
  }
}

# Subdomain mappings are always served through ghs.googlehosted.com.
resource "google_dns_record_set" "bartenders_cname" {
  project      = var.project_name
  name         = "${local.bartenders_host}."
  type         = "CNAME"
  ttl          = 300
  managed_zone = "cheetahmoongames-com"
  rrdatas      = ["ghs.googlehosted.com."]
}

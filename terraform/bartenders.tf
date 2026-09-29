# ---------------------------------------------------------------------------
# Bartenders of Corfu — bartenders.cheetahmoongames.com
# Deployed by mrkyle7/bartenders-of-corfu as bartenders-deploy
# (image: docker-us/bartenders).
# Supabase is external; its URL/key, the VAPID keys and the Brevo API key
# live in Secret Manager.
# ---------------------------------------------------------------------------

resource "google_service_account" "bartenders_run" {
  project      = var.project_name
  account_id   = "bartenders-run"
  display_name = "Cloud Run service account for bartenders"
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

# Brevo API key, for sending password reset emails. Its value comes from the
# BREVO_API_KEY GitHub secret in mrkyle7/bartenders-of-corfu, which that
# repo's deploy copies here. Until then the "not-set" placeholder below is the
# latest version: Cloud Run can't start a revision whose secret has no
# versions, and the app treats the placeholder as "don't send email".
resource "google_secret_manager_secret" "brevo_api_key" {
  project   = var.project_name
  secret_id = "brevo-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

# Write-only, so Terraform never reads a value back: the plan account, which
# can't read secret values, can still plan. The real key is added as a newer
# version outside Terraform.
resource "google_secret_manager_secret_version" "brevo_api_key_placeholder" {
  secret                 = google_secret_manager_secret.brevo_api_key.id
  secret_data_wo         = "not-set"
  secret_data_wo_version = 1
}

resource "google_secret_manager_secret_iam_member" "run_reads_brevo" {
  project   = var.project_name
  secret_id = google_secret_manager_secret.brevo_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bartenders_run.email}"
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

      # Players sign in on the home page, for every game; Bartenders' /login
      # sends them there. Bartenders still holds the accounts behind it.
      env {
        name  = "LOGIN_URL"
        value = "https://${var.domain_name}/login"
      }

      # Password reset emails, sent through Brevo, link to the home page.
      env {
        name = "BREVO_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.brevo_api_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "EMAIL_FROM"
        value = var.email_from
      }

      env {
        name  = "EMAIL_FROM_NAME"
        value = var.email_from_name
      }

      env {
        name  = "PASSWORD_RESET_URL"
        value = "https://${var.domain_name}/reset-password"
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
    google_secret_manager_secret_iam_member.run_reads_brevo,
    google_secret_manager_secret_version.brevo_api_key_placeholder,
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

# --- Deploying: mrkyle7/bartenders-of-corfu's main branch only ---------------
#
# The Bartenders repo's workflow acts as this account. It can push images to
# docker-us, deploy new revisions of the bartenders service (nothing else),
# and read and update the secrets it syncs on each deploy (Supabase, Brevo).

resource "google_service_account" "bartenders_deploy" {
  project      = var.project_name
  account_id   = "bartenders-deploy"
  display_name = "GitHub Actions deploys for bartenders"
}

# Only jobs running on the deploy branch may act as it, checked against
# GitHub's signed token, so a pull request that edits the workflow can't.
resource "google_service_account_iam_member" "github_deploy_bartenders" {
  for_each           = toset(var.bartenders_deploy_branches)
  service_account_id = google_service_account.bartenders_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_ref/${var.bartenders_github_repo}@refs/heads/${each.value}"
}

resource "google_cloud_run_v2_service_iam_member" "bartenders_deploy_developer" {
  project  = google_cloud_run_v2_service.bartenders.project
  location = google_cloud_run_v2_service.bartenders.location
  name     = google_cloud_run_v2_service.bartenders.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.bartenders_deploy.email}"
}

# Read-only, so the workflow can list revisions when rolling back.
resource "google_project_iam_member" "bartenders_deploy_run_viewer" {
  project = var.project_name
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.bartenders_deploy.email}"
}

# New revisions run as bartenders-run.
resource "google_service_account_iam_member" "bartenders_deploy_acts_as_run" {
  service_account_id = google_service_account.bartenders_run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.bartenders_deploy.email}"
}

resource "google_artifact_registry_repository_iam_member" "bartenders_deploy_pushes_images" {
  project    = var.project_name
  location   = google_artifact_registry_repository.docker_us.location
  repository = google_artifact_registry_repository.docker_us.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.bartenders_deploy.email}"
}

# Reads the current value (to diff) and adds a new version when it changed.
resource "google_secret_manager_secret_iam_member" "bartenders_deploy_secret_access" {
  for_each = {
    url_read    = { secret = google_secret_manager_secret.supabase_url.secret_id, role = "roles/secretmanager.secretAccessor" }
    key_read    = { secret = google_secret_manager_secret.supabase_key.secret_id, role = "roles/secretmanager.secretAccessor" }
    url_write   = { secret = google_secret_manager_secret.supabase_url.secret_id, role = "roles/secretmanager.secretVersionAdder" }
    key_write   = { secret = google_secret_manager_secret.supabase_key.secret_id, role = "roles/secretmanager.secretVersionAdder" }
    brevo_read  = { secret = google_secret_manager_secret.brevo_api_key.secret_id, role = "roles/secretmanager.secretAccessor" }
    brevo_write = { secret = google_secret_manager_secret.brevo_api_key.secret_id, role = "roles/secretmanager.secretVersionAdder" }
  }
  project   = var.project_name
  secret_id = each.value.secret
  role      = each.value.role
  member    = "serviceAccount:${google_service_account.bartenders_deploy.email}"
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

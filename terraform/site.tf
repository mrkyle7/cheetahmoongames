# ---------------------------------------------------------------------------
# cheetahmoongames.com — the games home page (site/ in this repo).
# Also redirects Bartenders' old URLs on this domain to its subdomain.
# ---------------------------------------------------------------------------

resource "google_service_account" "site_run" {
  project      = var.project_name
  account_id   = "cheetahmoongames-run"
  display_name = "Cloud Run service account for the cheetahmoongames.com home page"
}

# The home page's own image registry. This repo's workflow pushes to it as
# github-terraform.
resource "google_artifact_registry_repository" "site_images" {
  project       = var.project_name
  location      = var.region
  repository_id = "cheetahmoongames"
  description   = "Docker images for the cheetahmoongames.com home page"
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
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
}

resource "google_artifact_registry_repository_iam_member" "site_run_pulls_images" {
  project    = var.project_name
  location   = google_artifact_registry_repository.site_images.location
  repository = google_artifact_registry_repository.site_images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.site_run.email}"
}

# --- "Your games" ---------------------------------------------------------------
#
# The home page lists the games a signed-in player is in the middle of, and
# whose turn it is (site/games.js), by reading where each game keeps them.
# Read-only: the page's account can list and read the two games' buckets, and
# read the secrets holding Bezique's and Bartenders' database addresses and
# secret keys. It only ever asks for the signed-in player's own games.

locals {
  # Environment variable → Secret Manager secret.
  site_reads_secrets = {
    BEZIQUE_SUPABASE_URL    = module.game["bezique"].secrets["SUPABASE_URL"]
    BEZIQUE_SUPABASE_KEY    = module.game["bezique"].secrets["SUPABASE_KEY"]
    BARTENDERS_SUPABASE_URL = google_secret_manager_secret.supabase_url.secret_id
    BARTENDERS_SUPABASE_KEY = google_secret_manager_secret.supabase_key.secret_id
  }
}

resource "google_secret_manager_secret_iam_member" "site_reads_game_secrets" {
  for_each  = local.site_reads_secrets
  project   = var.project_name
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.site_run.email}"
}

resource "google_storage_bucket_iam_member" "site_reads_kings_keep" {
  bucket = google_storage_bucket.kings_keep.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.site_run.email}"
}

resource "google_storage_bucket_iam_member" "site_reads_secret_mermaids" {
  bucket = google_storage_bucket.secret_mermaids.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.site_run.email}"
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

      # Shows "Sign in with Google" on the sign-in page.
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }

      # "Your games" at the top of the page (site/games.js) reads each game's
      # saved tables directly, read-only: the two games kept in buckets, and
      # the two kept in Supabase, whose URLs and secret keys are the games'
      # own secrets (below).
      env {
        name  = "KINGS_KEEP_BUCKET"
        value = google_storage_bucket.kings_keep.name
      }

      env {
        name  = "SECRET_MERMAIDS_BUCKET"
        value = google_storage_bucket.secret_mermaids.name
      }

      dynamic "env" {
        for_each = local.site_reads_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      # Login keys from Bartenders' database, like the games (games.tf), so
      # the home page and /api/account/keys don't wait for Bartenders to wake.
      dynamic "env" {
        for_each = local.keys_from_supabase
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
    google_project_service.cloudrun,
    google_artifact_registry_repository_iam_member.site_run_pulls_images,
    google_secret_manager_secret_iam_member.site_reads_game_secrets,
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

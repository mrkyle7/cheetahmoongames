# ---------------------------------------------------------------------------
# Shared: APIs and a data bucket. docker-us predates per-game registries and
# now holds Bartenders' images only; other games get their own (modules/game).
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

# APIs this setup depends on. GitHub Actions call them as service accounts,
# which bill quota to this project, so they must be enabled here (a person's
# gcloud login often bills another project and hides a disabled API).
#
# cloudresourcemanager and serviceusage must be switched on by hand once
# before the first apply: terraform needs them to read anything, including
# this resource. See README ("One-time setup").
resource "google_project_service" "required" {
  for_each = toset([
    "cloudresourcemanager.googleapis.com", # project IAM policy
    "serviceusage.googleapis.com",         # reading and enabling APIs
    "iam.googleapis.com",                  # service accounts and the GitHub pool
    "iamcredentials.googleapis.com",       # GitHub Actions acting as service accounts
    "sts.googleapis.com",                  # exchanging GitHub's token
    "artifactregistry.googleapis.com",     # image registries
    "dns.googleapis.com",                  # the cheetahmoongames-com zone
    "storage.googleapis.com",              # state and data buckets
  ])
  project            = var.project_name
  service            = each.value
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

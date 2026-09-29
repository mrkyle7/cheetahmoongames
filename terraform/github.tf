# ---------------------------------------------------------------------------
# GitHub Actions → GCP. Workload Identity Federation lets the repos in
# local.github_repos act as the CI service account via OIDC (no keys).
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_name
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions Pool"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_name
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Actions OIDC Provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "attribute.repository in [${join(", ", [for r in local.github_repos : "'${r}'"])}]"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Repos that deploy through the CI service account. Each game's repo gets its
# own binding inside modules/game.
resource "google_service_account_iam_member" "github_deploy_bartenders" {
  service_account_id = "projects/${var.project_name}/serviceAccounts/${var.ci_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.bartenders_github_repo}"
}

resource "google_service_account_iam_member" "github_deploy_site" {
  service_account_id = "projects/${var.project_name}/serviceAccounts/${var.ci_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.site_github_repo}"
}

moved {
  from = google_service_account_iam_member.wif_github_terraform
  to   = google_service_account_iam_member.github_deploy_bartenders
}

# ---------------------------------------------------------------------------
# CI service account permissions
# ---------------------------------------------------------------------------

resource "google_project_iam_member" "ci_run_developer" {
  project = var.project_name
  role    = "roles/run.developer"
  member  = "serviceAccount:${var.ci_service_account}"
}

resource "google_project_iam_member" "ci_storage_admin" {
  project = var.project_name
  role    = "roles/storage.admin"
  member  = "serviceAccount:${var.ci_service_account}"
}

resource "google_artifact_registry_repository_iam_member" "ci_pushes_images" {
  project    = var.project_name
  location   = google_artifact_registry_repository.docker_us.location
  repository = google_artifact_registry_repository.docker_us.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.ci_service_account}"
}

# This repo's workflow applies the terraform, so the CI account must be able to
# manage everything defined here. It is the same account every game deploys
# with; only repos listed in local.github_repos can act as it.
locals {
  ci_terraform_roles = [
    "roles/run.admin",                       # services, their IAM and domain mappings
    "roles/iam.serviceAccountAdmin",         # per-service accounts and their IAM
    "roles/iam.serviceAccountUser",          # deploy services that run as those accounts
    "roles/iam.workloadIdentityPoolAdmin",   # the GitHub pool and provider
    "roles/resourcemanager.projectIamAdmin", # project-level role bindings like these
    "roles/secretmanager.admin",             # Bartenders' secrets and their IAM
    "roles/artifactregistry.admin",          # the image registry and its IAM
    "roles/dns.admin",                       # records in the cheetahmoongames-com zone
    "roles/serviceusage.serviceUsageAdmin",  # enabling APIs
  ]
}

resource "google_project_iam_member" "ci_terraform" {
  for_each = toset(local.ci_terraform_roles)
  project  = var.project_name
  role     = each.value
  member   = "serviceAccount:${var.ci_service_account}"
}

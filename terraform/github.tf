# ---------------------------------------------------------------------------
# GitHub Actions → GCP via Workload Identity Federation (OIDC, no keys).
#
# The provider accepts tokens from every repo in local.github_repos, but a
# token alone grants nothing. Each repo can only act as the service account
# bound to it below:
#
#   mrkyle7/cheetahmoongames     github-terraform   applies this terraform (admin)
#   mrkyle7/bartenders-of-corfu  bartenders-deploy  deploys bartenders only (bartenders.tf)
#   each game's repo             <name>-deploy      deploys that game only (modules/game)
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

# --- Terraform: this repo only ------------------------------------------------

# github-terraform was created by hand, before this terraform existed.
resource "google_service_account_iam_member" "github_terraform_site" {
  service_account_id = "projects/${var.project_name}/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.site_github_repo}"
}

# Everything this terraform manages, plus building and deploying the home page
# (Cloud Run and Artifact Registry admin cover that).
locals {
  terraform_roles = [
    "roles/run.admin",                       # services, their IAM and domain mappings
    "roles/iam.serviceAccountAdmin",         # runtime and deploy accounts, and their IAM
    "roles/iam.serviceAccountUser",          # create services that run as those accounts
    "roles/iam.workloadIdentityPoolAdmin",   # the GitHub pool and provider
    "roles/resourcemanager.projectIamAdmin", # project-level bindings like these
    "roles/secretmanager.admin",             # Bartenders' secrets and their IAM
    "roles/artifactregistry.admin",          # image registries and their IAM
    "roles/dns.admin",                       # records in the cheetahmoongames-com zone
    "roles/serviceusage.serviceUsageAdmin",  # enabling APIs
  ]
}

resource "google_project_iam_member" "terraform" {
  for_each = toset(local.terraform_roles)
  project  = var.project_name
  role     = each.value
  member   = "serviceAccount:${var.terraform_service_account}"
}

# Terraform state and the data bucket. Predates this file, hence the name.
resource "google_project_iam_member" "ci_storage_admin" {
  project = var.project_name
  role    = "roles/storage.admin"
  member  = "serviceAccount:${var.terraform_service_account}"
}

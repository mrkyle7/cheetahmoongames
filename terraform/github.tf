# ---------------------------------------------------------------------------
# GitHub Actions → GCP via Workload Identity Federation (OIDC, no keys).
#
# The provider accepts tokens from every repo in local.github_repos, but a
# token alone grants nothing. Each repo can only act as the service account
# bound to it below:
#
#   mrkyle7/cheetahmoongames     github-terraform   applies this terraform (admin),
#                                                   default branch only
#   mrkyle7/cheetahmoongames     github-terraform-  read-only plan, for pull requests
#                                plan
#   mrkyle7/bartenders-of-corfu  bartenders-deploy  deploys bartenders only, from main
#                                                   (bartenders.tf)
#   each game's repo             <name>-deploy      deploys that game only, from its
#                                                   deploy branch (modules/game)
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
  # Values come from GitHub's signed OIDC token, so a workflow can't fake them.
  # repository_ref ("owner/repo@refs/heads/master") lets a binding require a
  # branch: pull requests run as refs/pull/N/merge and other branches as their
  # own ref, so neither matches.
  attribute_mapping = {
    "google.subject"           = "assertion.sub"
    "attribute.repository"     = "assertion.repository"
    "attribute.repository_ref" = "assertion.repository + '@' + assertion.ref"
  }
  # pull_request_target runs with the default branch's ref, which would satisfy a
  # branch check, so it can never sign in. No repo here uses it.
  attribute_condition = join(" && ", [
    "attribute.repository in [${join(", ", [for r in local.github_repos : "'${r}'"])}]",
    "assertion.event_name != 'pull_request_target'",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# --- Terraform: this repo's default branch only ------------------------------
#
# github-terraform (created by hand, before this terraform existed) can change
# anything, so only workflows running on the default branch may act as it:
# merges, and manual runs started on that branch. A pull request that edits the
# workflow still runs as refs/pull/N/merge and is refused by GCP itself.

resource "google_service_account_iam_member" "github_terraform_site" {
  for_each           = toset(var.site_deploy_branches)
  service_account_id = "projects/${var.project_name}/serviceAccounts/${var.terraform_service_account}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_ref/${var.site_github_repo}@refs/heads/${each.value}"
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

# --- Plans on pull requests: read-only -----------------------------------------
#
# Any branch or pull request in this repo may act as this account, so it must
# never be able to change anything. It can read the project's configuration and
# IAM (not secret values) and the Terraform state. Plans run with -lock=false
# because taking the state lock needs write access.

resource "google_service_account" "terraform_plan" {
  project      = var.project_name
  account_id   = "github-terraform-plan"
  display_name = "Read-only Terraform plans for mrkyle7/cheetahmoongames pull requests"
}

resource "google_service_account_iam_member" "github_terraform_plan_site" {
  service_account_id = google_service_account.terraform_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.site_github_repo}"
}

resource "google_project_iam_member" "terraform_plan" {
  for_each = toset([
    "roles/viewer",                         # resources and their settings
    "roles/iam.securityReviewer",           # IAM policies on every resource
    "roles/iam.workloadIdentityPoolViewer", # the GitHub pool and provider
  ])
  project = var.project_name
  role    = each.value
  member  = "serviceAccount:${google_service_account.terraform_plan.email}"
}

# The state bucket is created by hand (see README), so only its IAM is here.
resource "google_storage_bucket_iam_member" "terraform_plan_reads_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.terraform_plan.email}"
}

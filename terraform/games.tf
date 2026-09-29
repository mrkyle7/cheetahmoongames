# ---------------------------------------------------------------------------
# Games deployed from their own repos, one entry each. Adding an entry here
# creates the Cloud Run service, <subdomain>.cheetahmoongames.com and the DNS
# record, and lets that repo deploy. See ADDING_A_GAME.md.
#
# Bartenders of Corfu is not in this list: it needs secrets and a database,
# so it has its own file (bartenders.tf).
# ---------------------------------------------------------------------------

locals {
  games = {
    boxer = {
      name        = "the-boxer"
      subdomain   = "boxer"
      github_repo = "mrkyle7/the-boxer"

      # Fights are WebSocket connections: let a whole match fit in one request,
      # and keep both fighters on the single instance that holds their room.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1
    }
  }
}

module "game" {
  source   = "./modules/game"
  for_each = local.games

  name        = each.value.name
  subdomain   = each.value.subdomain
  github_repo = each.value.github_repo

  deploy_branches = try(each.value.deploy_branches, null)

  min_instances    = try(each.value.min_instances, null)
  max_instances    = try(each.value.max_instances, null)
  timeout          = try(each.value.timeout, null)
  session_affinity = try(each.value.session_affinity, null)
  concurrency      = try(each.value.concurrency, null)
  cpu              = try(each.value.cpu, null)
  memory           = try(each.value.memory, null)
  env              = try(each.value.env, null)

  project          = var.project_name
  region           = var.region
  domain           = var.domain_name
  dns_zone         = var.dns_zone
  github_pool_name = google_iam_workload_identity_pool.github.name

  depends_on = [google_project_service.cloudrun]
}

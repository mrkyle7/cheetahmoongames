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

    bezique = {
      name        = "bezique"
      subdomain   = "bezique"
      github_repo = "mrkyle7/bezique"

      # Games live in memory, so both players must reach the same instance.
      # Each open page keeps a server-sent events stream open for updates:
      # let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000

      # Games are saved in the bezique Supabase project. The workflow in
      # mrkyle7/bezique fills these in from its GitHub secrets. The keys that
      # sign its notifications are in that database, made by the server.
      secrets = ["SUPABASE_URL", "SUPABASE_KEY"]
    }

    catch-the-flag = {
      name        = "catch-the-flag"
      subdomain   = "catch-the-flag"
      github_repo = "mrkyle7/catch-the-flag"

      # Races are WebSocket connections and rooms live in memory: let a
      # connection last an hour, and keep both players on one instance.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1
    }

    kings-keep = {
      name        = "kings-keep"
      subdomain   = "kings-keep"
      github_repo = "mrkyle7/kings-keep"

      # Tables live in memory, so every player must reach the same instance.
      # Each open page keeps a server-sent events stream open for updates:
      # let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000

      # Tables are saved here at the end of every turn (kings-keep.tf).
      env = { GAMES_BUCKET = "${var.project_name}-kings-keep" }
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
  secrets          = try(each.value.secrets, null)

  project          = var.project_name
  region           = var.region
  domain           = var.domain_name
  dns_zone         = var.dns_zone
  github_pool_name = google_iam_workload_identity_pool.github.name

  depends_on = [google_project_service.cloudrun, google_project_service.secretmanager]
}

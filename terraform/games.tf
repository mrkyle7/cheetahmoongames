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

    football-shootout = {
      name        = "football-shootout"
      subdomain   = "football-shootout"
      github_repo = "mrkyle7/football-shootout"

      # Online games live in memory, so both players must reach the same
      # instance. Each open page keeps a server-sent events stream open for
      # updates: let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000
    }

    slow-chess = {
      name        = "slow-chess"
      subdomain   = "slow-chess"
      github_repo = "mrkyle7/slow-chess"

      # Online games live in memory, so both players must reach the same
      # instance. Each game page keeps a server-sent events stream open for
      # updates: let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000

      # Turn-by-turn games are saved here after every move (slow-chess.tf).
      env = { GAMES_BUCKET = "${var.project_name}-slow-chess" }
    }

    hide-and-seek = {
      name        = "hide-and-seek"
      subdomain   = "hide-and-seek"
      github_repo = "mrkyle7/hide-and-seek"

      # Live games are WebSocket connections and rooms live in memory: let a
      # connection last an hour, and keep both players on one instance.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1
    }

    spell-battle = {
      name        = "spell-battle"
      subdomain   = "spell-battle"
      github_repo = "mrkyle7/spell-battle"

      # Like Hide And Seek: live games are WebSocket connections and rooms
      # live in memory, so every wizard in a room must reach one instance.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1

      # Players' records: the spells they've learned (spell-battle.tf).
      env = { PLAYERS_BUCKET = "${var.project_name}-spell-battle" }
    }

    fish-tales = {
      name        = "fish-tales"
      subdomain   = "fish-tales"
      github_repo = "mrkyle7/fish-tales"

      # Like Hide And Seek: live games are WebSocket connections and rooms
      # live in memory, so every player in a room must reach one instance.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1
    }

    secret-mermaids = {
      name        = "secret-mermaids"
      subdomain   = "secret-mermaids"
      github_repo = "mrkyle7/secret-mermaids"

      # Games live in memory, so every player must reach the same instance.
      # Each open page keeps a server-sent events stream open for updates:
      # let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000
    }

    the-cars = {
      name        = "the-cars"
      subdomain   = "cars"
      github_repo = "mrkyle7/the-cars"

      # Like The Boxer: races are WebSocket connections and rooms live in
      # memory, so every driver in a room must reach one instance.
      timeout          = "3600s"
      session_affinity = true
      concurrency      = 1000
      max_instances    = 1

      # Players' records: their car's colour and banked points (the-cars.tf).
      env = { PLAYERS_BUCKET = "${var.project_name}-the-cars" }
    }

    the-pirates = {
      name        = "the-pirates"
      subdomain   = "pirates"
      github_repo = "mrkyle7/the-pirates"

      # Games live in memory, so every captain in a game must reach the same
      # instance. Each open page keeps a server-sent events stream open for
      # updates: let one last an hour (the page reconnects after) and let one
      # instance hold many.
      max_instances = 1
      timeout       = "3600s"
      concurrency   = 1000
    }

    # Claude's Compaction. It isn't on the home page. It runs in the
    # browser and keeps nothing on the server, so the defaults suit it.
    claude = {
      name        = "claude"
      subdomain   = "claude"
      github_repo = "mrkyle7/claude"
    }

    # Etymon runs in the browser; its server only keeps each signed-in
    # player's record (etymon.tf). Players never need the same instance, so
    # the defaults suit it.
    etymon = {
      name        = "etymon"
      subdomain   = "etymon"
      github_repo = "mrkyle7/etymon"

      # Players' records: best scores, endings found and games played.
      env = { GAMES_BUCKET = "${var.project_name}-etymon" }
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

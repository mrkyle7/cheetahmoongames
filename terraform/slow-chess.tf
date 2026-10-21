# ---------------------------------------------------------------------------
# Slow Chess saves its turn-by-turn games to a bucket of its own, so a restart
# or deploy doesn't lose them: players can take days over a move. It writes
# each game as one JSON file after every move, with a generation check so two
# instances can't overwrite each other's moves (see mrkyle7/slow-chess
# store.js, which follows King's Keep). Live games with a clock stay in memory.
#
# Only slow-chess-run can read or write it. It's a regional Standard bucket in
# us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "slow_chess" {
  name     = "${var.project_name}-slow-chess"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Every save rewrites a game's file, so its age is the time since the last
  # move. Games untouched for 90 days are deleted. Only games: anything else
  # the game keeps here later (such as notification keys) must stay.
  lifecycle_rule {
    condition {
      age            = 90
      matches_prefix = ["games/"]
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    env       = var.env
    app       = "slow-chess"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "slow_chess_run" {
  bucket = google_storage_bucket.slow_chess.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["slow-chess"].run_service_account}"
}

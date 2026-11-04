# ---------------------------------------------------------------------------
# Secret Mermaids saves its games to a bucket of its own, so a restart or
# deploy doesn't lose games in progress. It writes each game as one JSON file
# at the start of every turn, with a generation check so two instances can't
# overwrite each other's turns (see mrkyle7/secret-mermaids src/store.js,
# which follows King's Keep).
#
# Only secret-mermaids-run can read or write it. It's a regional Standard
# bucket in us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "secret_mermaids" {
  name     = "${var.project_name}-secret-mermaids"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Every save rewrites a game's file, so its age is the time since the last
  # turn. Games untouched for 30 days are deleted (the game itself drops
  # them after two). Only games: anything else kept here later must stay.
  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["games/"]
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    env       = var.env
    app       = "secret-mermaids"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "secret_mermaids_run" {
  bucket = google_storage_bucket.secret_mermaids.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["secret-mermaids"].run_service_account}"
}

# ---------------------------------------------------------------------------
# The Pirates keeps its leaderboard (the best scores, this week and all
# time) in a bucket of its own: one JSON file, leaderboard.json, written with
# a generation check so a save never overwrites one it hasn't seen (see
# mrkyle7/the-pirates src/store.js). Games themselves live in memory.
#
# Scores are kept for good, so there's no lifecycle rule. Only the-pirates-run
# can read or write it. It's a regional Standard bucket in us-east1, which the
# Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "the_pirates" {
  name     = "${var.project_name}-the-pirates"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "the-pirates"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "the_pirates_run" {
  bucket = google_storage_bucket.the_pirates.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["the-pirates"].run_service_account}"
}

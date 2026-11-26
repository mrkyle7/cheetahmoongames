# ---------------------------------------------------------------------------
# The Boxer keeps its adventure leaderboard in a bucket of its own: one JSON
# file (adventure-leaderboard.json) holding the best 100 scores. The server
# writes it when an adventure ends, with a generation check so a save never
# overwrites one it hasn't seen (see mrkyle7/the-boxer scores.js), and serves
# it at /api/leaderboard. Without the bucket the board would start again on
# every deploy.
#
# Scores are kept for good, so there's no lifecycle rule. Only the-boxer-run
# can read or write it. It's a regional Standard bucket in us-east1, which the
# Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "the_boxer" {
  name     = "${var.project_name}-the-boxer"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "the-boxer"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "the_boxer_run" {
  bucket = google_storage_bucket.the_boxer.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["boxer"].run_service_account}"
}

# ---------------------------------------------------------------------------
# Guess What It Is keeps each signed-in player's place in each story in a
# bucket of its own, so they can come back to it on any device: one JSON file
# per player (players/<id>.json) with the answers they've given so far (see
# mrkyle7/guess-what-it-is store.js).
#
# Records are kept for good, so there's no lifecycle rule. Only
# guess-what-it-is-run can read or write it. It's a regional Standard bucket
# in us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "guess_what_it_is" {
  name     = "${var.project_name}-guess-what-it-is"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "guess-what-it-is"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "guess_what_it_is_run" {
  bucket = google_storage_bucket.guess_what_it_is.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["guess-what-it-is"].run_service_account}"
}

# ---------------------------------------------------------------------------
# Guess What It Is keeps two things in a bucket of its own (see
# mrkyle7/guess-what-it-is store.js):
#
#   players/<id>.json   each signed-in player's place in each story: the
#                       answers they've given so far, so they can come back
#                       to it on any device
#   voice/<id>          the narrator's recording of one line of a story,
#                       made at /record and played instead of the device's
#                       voice
#
# Both are kept for good, so there's no lifecycle rule. Only
# guess-what-it-is-run can read or write it; players hear recordings through
# the game's server, never from the bucket. It's a regional Standard bucket
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

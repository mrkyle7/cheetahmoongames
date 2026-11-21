# ---------------------------------------------------------------------------
# The Adventure keeps each signed-in player's journey in a bucket of its own,
# so they can carry on from any device: one JSON file per player
# (saves/<id>.json), written whenever the game saves (see mrkyle7/the-adventure
# store.js). The browser keeps its own copy too.
#
# Journeys are kept for good, so there's no lifecycle rule. Only
# the-adventure-run can read or write it. It's a regional Standard bucket in
# us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "the_adventure" {
  name     = "${var.project_name}-the-adventure"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "the-adventure"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "the_adventure_run" {
  bucket = google_storage_bucket.the_adventure.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["the-adventure"].run_service_account}"
}

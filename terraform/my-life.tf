# ---------------------------------------------------------------------------
# My Life keeps each signed-in player's life in a bucket of its own, so they
# can carry on from any device and a restart or deploy loses nothing: one
# JSON file per player (lives/<id>.json), rewritten after every move with a
# generation check so two tabs or instances can't overwrite each other (see
# mrkyle7/my-life server/storage.js).
#
# Lives are kept for good, so there's no lifecycle rule. Only my-life-run can
# read or write it. It's a regional Standard bucket in us-east1, which the
# Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "my_life" {
  name     = "${var.project_name}-my-life"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "my-life"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "my_life_run" {
  bucket = google_storage_bucket.my_life.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["my-life"].run_service_account}"
}

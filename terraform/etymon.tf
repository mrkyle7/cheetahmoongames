# ---------------------------------------------------------------------------
# Etymon keeps each signed-in player's record in a bucket of its own, so it
# isn't lost with the browser's storage and follows them between devices: one
# JSON file per player (players/<id>.json) with their best scores, the endings
# they've found and the games they've played. It writes with a generation
# check so two instances can't overwrite each other (see mrkyle7/etymon
# store.js, which follows Slow Chess and King's Keep).
#
# Records are kept for good, so there's no lifecycle rule. Only etymon-run can
# read or write it. It's a regional Standard bucket in us-east1, which the
# Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "etymon" {
  name     = "${var.project_name}-etymon"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "etymon"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "etymon_run" {
  bucket = google_storage_bucket.etymon.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["etymon"].run_service_account}"
}

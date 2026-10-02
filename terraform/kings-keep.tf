# ---------------------------------------------------------------------------
# King's Keep saves its tables to a bucket of its own, so a restart or deploy
# doesn't lose games in progress. It writes each table as one JSON file at the
# end of every turn, with a generation check so two instances can't overwrite
# each other's moves (see mrkyle7/kings-keep src/store.js).
#
# It also holds the keys that sign King's Keep's notifications, which the game
# makes itself, and the devices players turned notifications on for.
#
# Only kings-keep-run can read or write it. It's a regional Standard bucket in
# us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "kings_keep" {
  name     = "${var.project_name}-kings-keep"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Every save rewrites a table's file, so its age is the time since the last
  # move. Tables untouched for 90 days are deleted. Only tables: the game also
  # keeps the keys that sign its notifications and the list of players'
  # devices here (config/), which must stay.
  lifecycle_rule {
    condition {
      age            = 90
      matches_prefix = ["tables/"]
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    env       = var.env
    app       = "kings-keep"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "kings_keep_run" {
  bucket = google_storage_bucket.kings_keep.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["kings-keep"].run_service_account}"
}

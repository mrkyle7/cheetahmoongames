# ---------------------------------------------------------------------------
# The Cars keeps each signed-in player's record in a bucket of its own: the
# colour they painted their car in the design room, and the points they've
# banked from their races (for a shop, one day). One JSON file per player
# (players/<id>.json). It writes with a generation check so a save never
# overwrites one it hasn't seen (see mrkyle7/the-cars store.js). Guests'
# colours stay in their browser.
#
# Records are kept for good, so there's no lifecycle rule. Only the-cars-run
# can read or write it. It's a regional Standard bucket in us-east1, which the
# Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "the_cars" {
  name     = "${var.project_name}-the-cars"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "the-cars"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "the_cars_run" {
  bucket = google_storage_bucket.the_cars.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["the-cars"].run_service_account}"
}

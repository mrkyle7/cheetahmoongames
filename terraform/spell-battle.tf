# ---------------------------------------------------------------------------
# Spell Battle keeps each signed-in player's record in a bucket of its own, so
# the spells they've learned from the library's books follow them between
# devices: one JSON file per player (players/<id>.json). It writes with a
# generation check so a save never overwrites one it hasn't seen (see
# mrkyle7/spell-battle src/store.js). Guests' spells stay in their browser.
#
# Records are kept for good, so there's no lifecycle rule. Only
# spell-battle-run can read or write it. It's a regional Standard bucket in
# us-east1, which the Cloud Storage free tier covers.
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "spell_battle" {
  name     = "${var.project_name}-spell-battle"
  location = var.region
  project  = var.project_name

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    env       = var.env
    app       = "spell-battle"
    sensitive = "false"
  }
}

# Read, write, list and delete objects in this bucket only.
resource "google_storage_bucket_iam_member" "spell_battle_run" {
  bucket = google_storage_bucket.spell_battle.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.game["spell-battle"].run_service_account}"
}

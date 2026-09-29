output "site_cloud_run_url" {
  value       = google_cloud_run_v2_service.site.uri
  description = "Direct Cloud Run URL for the home page"
}

output "cloud_run_url" {
  value       = google_cloud_run_v2_service.bartenders.uri
  description = "Direct Cloud Run URL for Bartenders"
}

output "cloud_run_service_account" {
  value       = google_service_account.bartenders_run.email
  description = "Service account used by the Bartenders service"
}

output "games" {
  value       = { for key, game in module.game : key => game.url }
  description = "Public URL of each game in games.tf"
}

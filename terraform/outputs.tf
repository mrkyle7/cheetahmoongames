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
  value = {
    for key, game in module.game : key => {
      url                    = game.url
      deploy_service_account = game.deploy_service_account
      image_repository       = game.image_repository
    }
  }
  description = "Each game in games.tf: its URL, and what its workflow deploys as and pushes to"
}

output "bartenders_deploy_service_account" {
  value       = google_service_account.bartenders_deploy.email
  description = "Account the Bartenders repo's workflow deploys as"
}

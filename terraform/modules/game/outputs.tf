output "url" {
  value       = "https://${local.host}"
  description = "Public URL of the game"
}

output "cloud_run_url" {
  value       = google_cloud_run_v2_service.this.uri
  description = "Direct Cloud Run URL"
}

output "deploy_service_account" {
  value       = google_service_account.deploy.email
  description = "Account the game's GitHub workflow deploys as"
}

output "image_repository" {
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.images.repository_id}"
  description = "Where the game's workflow pushes images"
}

output "secrets" {
  value       = local.secret_ids
  description = "Secret Manager secret for each secret environment variable"
}

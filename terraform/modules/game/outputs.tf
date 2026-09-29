output "url" {
  value       = "https://${local.host}"
  description = "Public URL of the game"
}

output "cloud_run_url" {
  value       = google_cloud_run_v2_service.this.uri
  description = "Direct Cloud Run URL"
}

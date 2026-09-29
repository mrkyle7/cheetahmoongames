variable "env" {
  type        = string
  default     = "prod"
  description = "Environment"
}

variable "region" {
  type        = string
  default     = "us-east1"
  description = "GCP Region"
}

variable "app_name" {
  type        = string
  default     = "bartenders"
  description = "Label applied to the shared registry and bucket"
}

variable "project_name" {
  type        = string
  default     = "bartenders-464918"
  description = "GCP project that hosts every game"
}

variable "bucket_name" {
  type        = string
  default     = "bartenders-data"
  description = "Bucket name"
}

variable "domain_name" {
  type        = string
  default     = "cheetahmoongames.com"
  description = "Apex domain. Serves the games home page; each game has a subdomain."
}

variable "dns_zone" {
  type        = string
  default     = "cheetahmoongames-com"
  description = "Cloud DNS managed zone for domain_name"
}

variable "bartenders_subdomain" {
  type        = string
  default     = "bartenders"
  description = "Subdomain that serves Bartenders of Corfu"
}

variable "ci_service_account" {
  type        = string
  default     = "github-terraform@bartenders-464918.iam.gserviceaccount.com"
  description = "Service account GitHub Actions uses to deploy every game and to apply this terraform."
}

variable "site_github_repo" {
  type        = string
  default     = "mrkyle7/cheetahmoongames"
  description = "This repo: applies the terraform and deploys the home page."
}

variable "bartenders_github_repo" {
  type        = string
  default     = "mrkyle7/bartenders-of-corfu"
  description = "Repo that deploys Bartenders of Corfu"
}

locals {
  bartenders_host = "${var.bartenders_subdomain}.${var.domain_name}"

  # Every repo allowed to authenticate to GCP from GitHub Actions.
  github_repos = distinct(concat(
    [var.site_github_repo, var.bartenders_github_repo],
    [for game in values(local.games) : game.github_repo],
  ))
}

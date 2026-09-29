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

variable "terraform_service_account" {
  type        = string
  default     = "github-terraform@bartenders-464918.iam.gserviceaccount.com"
  description = "Service account this repo's workflow applies the terraform as. Only this repo may use it; games deploy with their own accounts."
}

variable "site_github_repo" {
  type        = string
  default     = "mrkyle7/cheetahmoongames"
  description = "This repo: applies the terraform and deploys the home page."
}

variable "site_deploy_branches" {
  type        = list(string)
  default     = ["master", "main"]
  description = "Branches of site_github_repo whose workflows may act as terraform_service_account. Everything else, pull requests included, only gets the read-only plan account."
}

variable "state_bucket" {
  type        = string
  default     = "bartenders-464918-tfstate"
  description = "Terraform state bucket. Must match the backend block in versions.tf."
}

variable "bartenders_github_repo" {
  type        = string
  default     = "mrkyle7/bartenders-of-corfu"
  description = "Repo that deploys Bartenders of Corfu"
}

variable "bartenders_deploy_branches" {
  type        = list(string)
  default     = ["main"]
  description = "Branches of bartenders_github_repo whose workflows may deploy Bartenders."
}

locals {
  bartenders_host = "${var.bartenders_subdomain}.${var.domain_name}"

  # Every repo allowed to authenticate to GCP from GitHub Actions.
  github_repos = distinct(concat(
    [var.site_github_repo, var.bartenders_github_repo],
    [for game in values(local.games) : game.github_repo],
  ))
}

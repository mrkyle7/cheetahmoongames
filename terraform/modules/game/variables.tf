variable "name" {
  type        = string
  description = "Cloud Run service, image registry and image name (e.g. the-boxer). At most 23 characters: accounts are named <name>-deploy."
}

variable "subdomain" {
  type        = string
  description = "Serves the game at <subdomain>.<domain>."
}

variable "github_repo" {
  type        = string
  description = "owner/repo whose GitHub Actions deploy this game."
}

variable "deploy_branches" {
  type        = list(string)
  default     = ["main"]
  nullable    = false
  description = "Branches of github_repo whose workflows may deploy. Pull requests and other branches can't."
}

# --- Runtime settings (all optional) -------------------------------------------

variable "min_instances" {
  type     = number
  default  = 0
  nullable = false
}

variable "max_instances" {
  type     = number
  default  = 3
  nullable = false
}

variable "timeout" {
  type        = string
  default     = null
  description = "Longest a request may run, e.g. \"3600s\" for WebSocket games. Cloud Run's default is 300s."
}

variable "session_affinity" {
  type     = bool
  default  = false
  nullable = false
}

variable "concurrency" {
  type        = number
  default     = null
  description = "Requests (or WebSocket connections) one instance handles at once. Cloud Run's default is 80."
}

variable "cpu" {
  type     = string
  default  = "1"
  nullable = false
}

variable "memory" {
  type     = string
  default  = "512Mi"
  nullable = false
}

variable "env" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Plain environment variables for the container."
}

variable "secrets" {
  type        = list(string)
  default     = []
  nullable    = false
  description = <<-EOT
    Environment variables whose values are secret, e.g. ["SUPABASE_URL", "SUPABASE_KEY"].
    Each gets a Secret Manager secret named <name>-<variable in lower case with dashes>
    (bezique-supabase-url), which the game's deploy workflow fills in. See
    "Games that need secrets or a database" in ADDING_A_GAME.md.
  EOT

  validation {
    condition     = alltrue([for s in var.secrets : can(regex("^[A-Z][A-Z0-9_]*$", s))])
    error_message = "Secrets are environment variable names: capitals, digits and underscores."
  }
}

# --- Wiring from the root module ------------------------------------------------

variable "project" {
  type = string
}

variable "region" {
  type = string
}

variable "domain" {
  type = string
}

variable "dns_zone" {
  type = string
}

variable "github_pool_name" {
  type        = string
  description = "Full name of the Workload Identity pool (projects/.../workloadIdentityPools/github-pool)."
}

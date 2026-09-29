terraform {
  required_version = ">= 1.14.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
  }

  # State lives in GCS so GitHub Actions and people share one copy. The bucket
  # is created once by hand; see README.md ("One-time setup").
  backend "gcs" {
    bucket = "bartenders-464918-tfstate"
    prefix = "cheetahmoongames"
  }
}

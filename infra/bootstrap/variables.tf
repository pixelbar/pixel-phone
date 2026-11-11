variable "subscription_id" {
  type        = string
  description = "Pixelbar's Azure subscription. Not a secret."
  default     = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a UUID."
  }
}

variable "location" {
  type        = string
  description = "Azure region. West Europe is the Pixelbar default."
  default     = "westeurope"
}

variable "prefix" {
  type        = string
  description = "Name prefix. Resource groups become {prefix}-bootstrap, {prefix}-dev and {prefix}-prod."
  default     = "pixel-phone"

  validation {
    condition     = can(regex("^[a-z0-9-]{2,20}$", var.prefix))
    error_message = "prefix must be 2–20 lowercase letters, digits or hyphens."
  }
}

variable "github_repository" {
  type        = string
  description = "GitHub org/repo that may federate to the GitHub identities. Other repos cannot."
  default     = "pixelbar/pixel-phone"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be org/repo."
  }
}

# GitHub OIDC subjects for repositories created after 2026-07-15 use numeric
# owner and repository IDs. The name-only subject never matches.
variable "github_owner_id" {
  type        = string
  description = "GitHub organization numeric ID for the OIDC subject. pixelbar is 1690472."
  default     = "1690472"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be a numeric GitHub org or user ID."
  }
}

variable "github_repository_id" {
  type        = string
  description = "GitHub repository numeric ID for the OIDC subject. pixelbar/pixel-phone is 1453907426."
  default     = "1453907426"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be a numeric GitHub repository ID."
  }
}

variable "state_resource_group" {
  type        = string
  description = "Resource group of the shared Terraform state account (created by Pixel's bootstrap)."
  default     = "pixel-bootstrap"
}

variable "state_storage_account" {
  type        = string
  description = "Shared Terraform state account, also used by Pixel and spacestate."
  default     = "pixelbartfstate"
}

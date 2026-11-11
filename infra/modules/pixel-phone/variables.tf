variable "environment" {
  type        = string
  description = "dev or prod."

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "prefix" {
  type        = string
  description = "Name prefix. Resources are named {prefix}-{environment}-*."
  default     = "pixel-phone"
}

variable "resource_group_name" {
  type        = string
  description = "The environment's resource group. Created by infra/bootstrap, not here."
}

variable "key_vault_name" {
  type        = string
  description = "Globally unique Key Vault name (3–24 characters)."
}

variable "storage_account_name" {
  type        = string
  description = "Globally unique storage account name (3–24 lowercase letters or digits)."

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must be 3–24 lowercase letters or digits."
  }
}

variable "container_image" {
  type        = string
  description = "The image the Container App is created with. After that, deploys own the image (az containerapp update) and Terraform ignores it."
}

variable "pixel_principal_id" {
  type        = string
  description = "Optional. The principal ID of Pixel's managed identity in the same environment, which may read and delete messages on phone-events (ADR 0006)."
  default     = null
}

variable "log_retention_days" {
  type        = number
  description = "Log Analytics retention."
  default     = 30
}

variable "purge_protection_enabled" {
  type        = bool
  description = "Key Vault purge protection. Off for dev so it can be torn down; on for prod."
  default     = false
}

variable "extra_env" {
  type        = map(string)
  description = "Plain (non-secret) environment variables for the container, on top of the ones the module sets."
  default     = {}
}

# --- Features (infra/secrets.manifest.yaml) -----------------------------------
# Turn a feature on only after `just secrets-push <env>` has put its secrets in Key
# Vault: the Container App can't start a revision that references a missing secret.

variable "telnyx_enabled" {
  type        = bool
  description = "Telnyx Call Control: references telnyx-api-key and telnyx-public-key."
  default     = false
}

variable "home_assistant_url" {
  type        = string
  description = "Optional. HOME_ASSISTANT_URL (the Nabu Casa URL). Setting it references home-assistant-token."
  default     = null

  validation {
    condition     = var.home_assistant_url == null || can(regex("^https://", var.home_assistant_url))
    error_message = "home_assistant_url must be an https URL or unset."
  }
}

variable "home_assistant_ringing_entity" {
  type        = string
  description = "The input_boolean pixel-phone flips while a call rings (ADR 0005). dev must use the _dev helper."
  default     = null
}

variable "accept_api_enabled" {
  type        = bool
  description = "The accept API: references api-keys-yaml."
  default     = false
}

variable "sentry_enabled" {
  type        = bool
  description = "Sentry error reporting: references sentry-dsn."
  default     = false
}

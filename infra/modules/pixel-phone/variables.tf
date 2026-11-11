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

variable "maintainer_principal_ids" {
  type        = map(string)
  description = "Maintainers who push secrets and recordings, as name => Entra ID user object ID. Each gets Key Vault Administrator on the vault and Storage Blob Data Contributor on media. Not secrets."
  default     = {}
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

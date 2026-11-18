provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # The GitHub prod identity is Contributor on pixel-phone-prod only and can't
  # register providers. Every provider this stack needs is already registered
  # (dev, Pixel and spacestate use them).
  resource_provider_registrations = "none"

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }

    key_vault {
      # prod keeps purge protection: a deleted vault is recoverable, never purged.
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }

    log_analytics_workspace {
      permanently_delete_on_destroy = false
    }
  }
}

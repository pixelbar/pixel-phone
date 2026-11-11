provider "azurerm" {
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
  # Pixel and spacestate already use Container Apps, Key Vault, Storage and
  # Log Analytics in this subscription; ManagedIdentity is the one this stack needs.
  resource_providers_to_register = [
    "Microsoft.ManagedIdentity",
  ]

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

data "azurerm_client_config" "current" {}

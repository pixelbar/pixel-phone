module "pixel_phone" {
  source = "../../modules/pixel-phone"

  environment              = "dev"
  resource_group_name      = "pixel-phone-dev"
  key_vault_name           = "pixel-phone-dev-kv"
  storage_account_name     = "pixelphonedevst"
  container_image          = var.container_image
  pixel_principal_id       = var.pixel_principal_id
  maintainer_principal_ids = var.maintainer_principal_ids
  purge_protection_enabled = false

  extra_env = {
    # Only the placeholder image reads this; the real service ignores it.
    WHOAMI_PORT_NUMBER = "3000"
  }
}

# The maintainer roles used to follow whoever ran Terraform. They are now keyed by
# name; these keep dev's existing assignments instead of recreating them.
moved {
  from = module.pixel_phone.azurerm_role_assignment.applyer_kv_admin
  to   = module.pixel_phone.azurerm_role_assignment.maintainer_kv_admin["ninjalikescheez"]
}

moved {
  from = module.pixel_phone.azurerm_role_assignment.applyer_media
  to   = module.pixel_phone.azurerm_role_assignment.maintainer_media["ninjalikescheez"]
}

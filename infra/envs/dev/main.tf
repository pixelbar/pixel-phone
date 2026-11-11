module "pixel_phone" {
  source = "../../modules/pixel-phone"

  environment              = "dev"
  resource_group_name      = "pixel-phone-dev"
  key_vault_name           = "pixel-phone-dev-kv"
  storage_account_name     = "pixelphonedevst"
  container_image          = var.container_image
  pixel_principal_id       = var.pixel_principal_id
  purge_protection_enabled = false

  extra_env = {
    # Only the placeholder image reads this; the real service ignores it.
    WHOAMI_PORT_NUMBER = "3000"
  }
}

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

  # Features: turn each on only after `just secrets-push dev` (infra/secrets.manifest.yaml).
  telnyx_enabled                = var.telnyx_enabled
  home_assistant_url            = var.home_assistant_url
  home_assistant_ringing_entity = "input_boolean.pixel_phone_ringing_dev"
  accept_api_enabled            = var.accept_api_enabled
  sentry_enabled                = var.sentry_enabled
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

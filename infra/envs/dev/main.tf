module "pixel_phone" {
  source = "../../modules/pixel-phone"

  environment              = "dev"
  resource_group_name      = "pixel-phone-dev"
  key_vault_name           = "pixel-phone-dev-kv"
  storage_account_name     = "pixelphonedevst"
  container_image          = var.container_image
  pixel_principal_id       = var.pixel_principal_id
  purge_protection_enabled = false

  # Features: turn each on only after `just secrets-push dev` (infra/secrets.manifest.yaml).
  telnyx_enabled                = var.telnyx_enabled
  home_assistant_url            = var.home_assistant_url
  home_assistant_ringing_entity = "input_boolean.pixel_phone_ringing_dev"
  accept_api_enabled            = var.accept_api_enabled
  sentry_enabled                = var.sentry_enabled
}

module "pixel_phone" {
  source = "../../modules/pixel-phone"

  environment              = "prod"
  resource_group_name      = "pixel-phone-prod"
  key_vault_name           = "pixel-phone-prod-kv"
  storage_account_name     = "pixelphoneprodst"
  container_image          = var.container_image
  pixel_principal_id       = var.pixel_principal_id
  maintainer_principal_ids = var.maintainer_principal_ids
  purge_protection_enabled = true
  recording_accepted       = var.recording_accepted
  custom_domains           = var.custom_domains

  # Features: turn each on only after `just secrets-push prod` (infra/secrets.manifest.yaml).
  telnyx_enabled                = var.telnyx_enabled
  home_assistant_url            = var.home_assistant_url
  home_assistant_ringing_entity = "input_boolean.pixel_phone_ringing"
  accept_api_enabled            = var.accept_api_enabled
  sentry_enabled                = var.sentry_enabled
}

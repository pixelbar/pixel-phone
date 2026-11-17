locals {
  name_prefix = "${var.prefix}-${var.environment}"
  location    = data.azurerm_resource_group.this.location

  tags = {
    project = "pixel-phone"
    env     = var.environment
    stack   = "pixel-phone"
  }

  # The port the service listens on (src/config.ts reads PORT).
  port = 3000

  table_names = toset(["Calls", "WebhookEvents"])
  queue_name  = "phone-events"
  media_name  = "media"

  storage_scope = azurerm_storage_account.this.id
  queue_scope   = "${local.storage_scope}/queueServices/default/queues/${local.queue_name}"
  media_scope   = "${local.storage_scope}/blobServices/default/containers/${local.media_name}"

  # Which secrets exist, what they're called in Key Vault and which environment
  # variable carries each live in infra/secrets.manifest.yaml, not here. This map only
  # says when each feature applies; a feature the manifest names but this map doesn't
  # fails the plan, and tests/scripts/secrets-manifest.test.ts catches it earlier.
  secrets_manifest = yamldecode(file("${path.module}/../../secrets.manifest.yaml"))

  secret_features = {
    telnyx         = var.telnyx_enabled
    home-assistant = var.home_assistant_url != null
    accept-api     = var.accept_api_enabled
    sentry         = var.sentry_enabled
  }

  enabled_secrets = [
    for s in local.secrets_manifest.secrets : s if local.secret_features[s.feature]
  ]

  # URIs only. Terraform never reads or writes the values.
  key_vault_secret_ids = {
    for s in local.enabled_secrets : s.vault => "${azurerm_key_vault.this.vault_uri}secrets/${s.vault}"
  }

  # Environment variable => Key Vault secret name.
  app_secret_env = { for s in local.enabled_secrets : s.env => s.vault }

  app_plain_env = merge(
    {
      PIXEL_PHONE_ENV            = var.environment
      PORT                       = tostring(local.port)
      AZURE_CLIENT_ID            = azurerm_user_assigned_identity.app.client_id
      AZURE_STORAGE_ACCOUNT_NAME = azurerm_storage_account.this.name
      PHONE_EVENTS_QUEUE         = local.queue_name
      MEDIA_CONTAINER            = local.media_name
    },
    var.home_assistant_url != null ? { HOME_ASSISTANT_URL = var.home_assistant_url } : {},
    var.home_assistant_ringing_entity != null ? { HOME_ASSISTANT_RINGING_ENTITY = var.home_assistant_ringing_entity } : {},
    var.extra_env,
  )
}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

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

  app_plain_env = merge(
    {
      PIXEL_PHONE_ENV            = var.environment
      PORT                       = tostring(local.port)
      AZURE_CLIENT_ID            = azurerm_user_assigned_identity.app.client_id
      AZURE_STORAGE_ACCOUNT_NAME = azurerm_storage_account.this.name
      PHONE_EVENTS_QUEUE         = local.queue_name
      MEDIA_CONTAINER            = local.media_name
    },
    var.extra_env,
  )
}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

data "azurerm_client_config" "current" {}

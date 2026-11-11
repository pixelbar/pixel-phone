resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name_prefix}-app"
  resource_group_name = data.azurerm_resource_group.this.name
  location            = local.location
  tags                = local.tags
}

# --- The app (ADR 0004, 0006, 0008) -------------------------------------------

resource "azurerm_role_assignment" "app_kv_secrets" {
  scope                            = azurerm_key_vault.this.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "app_tables" {
  for_each = local.table_names

  scope                            = "${local.storage_scope}/tableServices/default/tables/${each.key}"
  role_definition_name             = "Storage Table Data Contributor"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_storage_table.this]
}

resource "azurerm_role_assignment" "app_queue_sender" {
  scope                            = local.queue_scope
  role_definition_name             = "Storage Queue Data Message Sender"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_storage_queue.events]
}

# Read the recordings, never write them.
resource "azurerm_role_assignment" "app_media_reader" {
  scope                            = local.media_scope
  role_definition_name             = "Storage Blob Data Reader"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_storage_container.media]
}

# Signs the short-lived user-delegation SAS URLs Telnyx plays recordings from.
resource "azurerm_role_assignment" "app_blob_delegator" {
  scope                            = local.storage_scope
  role_definition_name             = "Storage Blob Delegator"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  skip_service_principal_aad_check = true
}

# --- Pixel (ADR 0006): read and delete call events, nothing else ---------------

resource "azurerm_role_assignment" "pixel_queue_processor" {
  count = var.pixel_principal_id != null ? 1 : 0

  scope                            = local.queue_scope
  role_definition_name             = "Storage Queue Data Message Processor"
  principal_id                     = var.pixel_principal_id
  skip_service_principal_aad_check = true
  depends_on                       = [azurerm_storage_queue.events]
}

# --- Whoever applies this stack (a maintainer, from a laptop) -------------------

# just secrets-push writes the app's secrets.
resource "azurerm_role_assignment" "applyer_kv_admin" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

# just media push uploads recordings.
resource "azurerm_role_assignment" "applyer_media" {
  scope                = local.media_scope
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
  depends_on           = [azurerm_storage_container.media]
}

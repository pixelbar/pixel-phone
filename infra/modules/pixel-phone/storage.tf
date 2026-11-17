# Azure AD only: with shared keys off, every read or write needs a Storage Data
# role, which only the app (scoped as in identity.tf), Pixel (the queue) and the
# maintainer who applies this stack hold. Contributor on the resource group
# cannot list keys and read the data.
resource "azurerm_storage_account" "this" {
  name                     = var.storage_account_name
  resource_group_name      = data.azurerm_resource_group.this.name
  location                 = local.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  https_traffic_only_enabled      = true
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  local_user_enabled              = false

  tags = local.tags
}

# Calls (ADR 0004) and Telnyx webhook IDs seen, for de-duplication.
resource "azurerm_storage_table" "this" {
  for_each = local.table_names

  name               = each.key
  storage_account_id = azurerm_storage_account.this.id
}

# Call events for Pixel (ADR 0006).
resource "azurerm_storage_queue" "events" {
  name               = local.queue_name
  storage_account_id = azurerm_storage_account.this.id
}

# Recordings (ADR 0008). Private: Telnyx gets short-lived SAS URLs.
resource "azurerm_storage_container" "media" {
  name                  = local.media_name
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

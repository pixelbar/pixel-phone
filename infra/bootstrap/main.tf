locals {
  environments = toset(["dev", "prod"])

  tags = {
    project = "pixel-phone"
    stack   = "bootstrap"
  }
}

resource "azurerm_resource_group" "bootstrap" {
  name     = "${var.prefix}-bootstrap"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "env" {
  for_each = local.environments

  name     = "${var.prefix}-${each.key}"
  location = var.location
  tags     = merge(local.tags, { env = each.key })
}

# Shared with Pixel and spacestate; this stack only adds containers to it.
data "azurerm_storage_account" "state" {
  name                = var.state_storage_account
  resource_group_name = var.state_resource_group
}

# The env stacks' state. The bootstrap container itself is created by hand
# before the first init (README), so this stack never has to migrate state.
resource "azurerm_storage_container" "state" {
  for_each = local.environments

  name                  = "${var.prefix}-${each.key}"
  storage_account_id    = data.azurerm_storage_account.state.id
  container_access_type = "private"
}

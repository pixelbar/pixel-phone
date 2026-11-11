# One identity per GitHub Environment. It can log in to Azure only from a
# workflow job in that environment of this repository, and can only reach that
# environment's resource group and state container.
resource "azurerm_user_assigned_identity" "github" {
  for_each = local.environments

  name                = "${var.prefix}-github-${each.key}"
  resource_group_name = azurerm_resource_group.bootstrap.name
  location            = azurerm_resource_group.bootstrap.location
  tags                = merge(local.tags, { env = each.key })
}

resource "azurerm_federated_identity_credential" "github" {
  for_each = local.environments

  name                      = "github-environment-${each.key}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github[each.key].id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  # GitHub immutable OIDC: repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ENV
  subject = "repo:${split("/", var.github_repository)[0]}@${var.github_owner_id}/${split("/", var.github_repository)[1]}@${var.github_repository_id}:environment:${each.key}"
}

resource "azurerm_role_assignment" "github_state" {
  for_each = local.environments

  # A container's ARM scope is built from the account's ID: the container
  # resource's own id is not guaranteed to be an ARM resource ID.
  scope                = "${data.azurerm_storage_account.state.id}/blobServices/default/containers/${azurerm_storage_container.state[each.key].name}"
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
  # The identity exists before Entra has replicated it.
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "github_env" {
  for_each = local.environments

  scope                            = azurerm_resource_group.env[each.key].id
  role_definition_name             = "Contributor"
  principal_id                     = azurerm_user_assigned_identity.github[each.key].principal_id
  skip_service_principal_aad_check = true
}

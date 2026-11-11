output "subscription_id" {
  value       = var.subscription_id
  description = "Put this in each GitHub Environment as ARM_SUBSCRIPTION_ID (a variable, not a secret)."
}

output "tenant_id" {
  value       = data.azurerm_client_config.current.tenant_id
  description = "Put this in each GitHub Environment as ARM_TENANT_ID."
}

output "environment_resource_groups" {
  value = { for name, rg in azurerm_resource_group.env : name => rg.name }
}

output "state_containers" {
  value = { for name, c in azurerm_storage_container.state : name => c.name }
}

output "github_client_ids" {
  value       = { for name, id in azurerm_user_assigned_identity.github : name => id.client_id }
  description = "Per-environment client IDs. Put each in that GitHub Environment as ARM_CLIENT_ID."
}

output "github_principal_ids" {
  value = { for name, id in azurerm_user_assigned_identity.github : name => id.principal_id }
}

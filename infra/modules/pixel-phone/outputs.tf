output "fqdn" {
  value       = azurerm_container_app.this.ingress[0].fqdn
  description = "The app's public hostname. Telnyx's webhook is https://<fqdn>/webhooks/telnyx."
}

output "container_app_name" {
  value = azurerm_container_app.this.name
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}

output "storage_account_name" {
  value = azurerm_storage_account.this.name
}

output "queue_url" {
  value       = "${azurerm_storage_account.this.primary_queue_endpoint}${local.queue_name}"
  description = "Pixel's PIXEL_PHONE_QUEUE_URL for this environment."
}

output "app_identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "app_identity_principal_id" {
  value = azurerm_user_assigned_identity.app.principal_id
}

output "fqdn" {
  value       = azurerm_container_app.this.ingress[0].fqdn
  description = "The app's public hostname. Telnyx's webhook is https://<fqdn>/webhooks/telnyx."
}

output "domain_verification_id" {
  value       = azurerm_container_app_environment.this.custom_domain_verification_id
  description = "The TXT record at asuid.<host> each custom domain needs before it can be added to custom_domains."
}

output "custom_domains" {
  value = var.custom_domains
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

output "fqdn" {
  value = module.pixel_phone.fqdn
}

output "webhook_url" {
  value       = "https://${module.pixel_phone.fqdn}/webhooks/telnyx"
  description = "Telnyx's webhook URL for dev."
}

output "container_app_name" {
  value = module.pixel_phone.container_app_name
}

output "key_vault_name" {
  value = module.pixel_phone.key_vault_name
}

output "storage_account_name" {
  value = module.pixel_phone.storage_account_name
}

output "queue_url" {
  value = module.pixel_phone.queue_url
}

output "app_identity_principal_id" {
  value = module.pixel_phone.app_identity_principal_id
}

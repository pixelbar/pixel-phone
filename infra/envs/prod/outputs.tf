output "fqdn" {
  value       = module.pixel_phone.fqdn
  description = "The Container App's own *.azurecontainerapps.io hostname: phone.pixelbar.nl's CNAME points here."
}

output "domain_verification_id" {
  value       = module.pixel_phone.domain_verification_id
  description = "The TXT record at asuid.phone.pixelbar.nl."
}

output "webhook_url" {
  value       = "https://${contains(module.pixel_phone.custom_domains, "phone.pixelbar.nl") ? "phone.pixelbar.nl" : module.pixel_phone.fqdn}/webhooks/telnyx"
  description = "Telnyx's webhook URL for prod: phone.pixelbar.nl once it is bound, the app's own hostname until then."
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
  value       = module.pixel_phone.queue_url
  description = "Pixel prod's PIXEL_PHONE_QUEUE_URL."
}

output "app_identity_principal_id" {
  value = module.pixel_phone.app_identity_principal_id
}

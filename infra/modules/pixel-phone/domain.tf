# Custom hostnames (prod: phone.pixelbar.nl), each with a free managed certificate.
# Done the way spacestate does it (infra/domain.tf there).
#
# DNS for pixelbar.nl lives outside Azure, so a domain is added in two phases:
#   1. Create its records by hand from the stack's outputs: a CNAME to `default_fqdn`
#      and a TXT at asuid.<host> holding `domain_verification_id`.
#   2. Once DNS has propagated, add the hostname to `custom_domains` and apply.
#      Listing it before then fails the certificate's validation.
#
# Azure won't issue a managed certificate until the hostname is attached to an app
# in the environment, so each domain is bound in three ordered steps in one apply:
#   1. attach the hostname with no certificate (binding Disabled)
#   2. issue the managed certificate (CNAME validation reuses the record the
#      hostname needs, so no HTTP validation path has to stay up)
#   3. bind the certificate to the hostname
#
# Steps 1 and 3 go through hostname.sh rather than azurerm_container_app_custom_domain:
# every hostname write rewrites the app's whole domain list, the provider only locks
# its creates against each other, and the bind has to be done with the az CLI anyway.
# So applying a stack with custom_domains needs the az CLI, signed in, on the laptop.
locals {
  hostname_script = {
    script         = "${path.module}/hostname.sh"
    app            = azurerm_container_app.this.name
    resource_group = data.azurerm_resource_group.this.name
  }
}

resource "terraform_data" "hostname" {
  for_each = var.custom_domains

  triggers_replace = [each.key]

  # Destroy provisioners can only read self.
  input = local.hostname_script

  provisioner "local-exec" {
    command = "${self.input.script} add ${self.input.app} ${self.input.resource_group} ${each.key}"
  }

  # Normally a no-op: bind_certificate's destroy has already taken the hostname off.
  # Covers a domain removed before its certificate was bound.
  provisioner "local-exec" {
    when    = destroy
    command = "${self.input.script} delete ${self.input.app} ${self.input.resource_group} ${each.key}"
  }
}

resource "azurerm_container_app_environment_managed_certificate" "this" {
  for_each = var.custom_domains

  name                         = replace(each.key, ".", "-")
  container_app_environment_id = azurerm_container_app_environment.this.id
  subject_name                 = each.key
  domain_control_validation    = "CNAME"
  tags                         = local.tags

  depends_on = [terraform_data.hostname]
}

resource "terraform_data" "bind_certificate" {
  for_each = var.custom_domains

  triggers_replace = [
    azurerm_container_app_environment_managed_certificate.this[each.key].id,
    each.key,
  ]

  input = local.hostname_script

  provisioner "local-exec" {
    command = join(" ", [
      self.input.script, "bind", self.input.app, self.input.resource_group, each.key,
      azurerm_container_app_environment.this.name,
      azurerm_container_app_environment_managed_certificate.this[each.key].id,
    ])
  }

  # Removing a domain destroys this, then the certificate, then the hostname (the
  # reverse of creation). Azure refuses to delete a certificate that is still bound
  # (CertificateInUse), and there is no az command to unbind one, so take the
  # hostname off the app here first.
  provisioner "local-exec" {
    when    = destroy
    command = "${self.input.script} delete ${self.input.app} ${self.input.resource_group} ${self.triggers_replace[1]}"
  }
}

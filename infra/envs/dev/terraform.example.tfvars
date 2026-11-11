# The settings dev is applied with. None of these are secrets; CI plans with
# this file. Copy to terraform.tfvars (gitignored) only to override something.

pixel_principal_id = "c43a84a4-f599-405c-8010-53bff92310dd" # pixel-dev-app

# Features stay off until their secrets are in Key Vault (just secrets-push dev).
telnyx_enabled     = false
accept_api_enabled = false
sentry_enabled     = false
# home_assistant_url = "https://<instance>.ui.nabu.casa"

# Who may run just secrets-push and just media push against dev. Find an object ID
# with: az ad user show --id <upn> --query id -o tsv
maintainer_principal_ids = {
  ninjalikescheez = "c98fe67e-0682-49d6-85cf-cc9946647392" # NinjaLikesCheez@pixelbar.nl
}

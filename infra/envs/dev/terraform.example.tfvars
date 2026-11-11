# The settings dev is applied with. None of these are secrets; CI plans with
# this file. Copy to terraform.tfvars (gitignored) only to override something.

pixel_principal_id = "c43a84a4-f599-405c-8010-53bff92310dd" # pixel-dev-app

# Features stay off until their secrets are in Key Vault (just secrets-push dev).
telnyx_enabled     = false
accept_api_enabled = false
sentry_enabled     = true # sentry-dsn pushed 2026-11-11
# home_assistant_url = "https://<instance>.ui.nabu.casa"

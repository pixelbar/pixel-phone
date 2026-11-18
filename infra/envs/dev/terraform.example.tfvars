# A starting point for dev's settings, and what CI plans dev with on pull requests.
# dev is applied with terraform.tfvars (gitignored), shared through Key Vault:
# `just pull dev`, edit, `just push dev` (docs/runbook.md#terraform-settings).
# None of these are secrets. Keep this close to dev's real settings.

pixel_principal_id = "c43a84a4-f599-405c-8010-53bff92310dd" # pixel-dev-app

# Features stay off until their secrets are in Key Vault (just secrets-push dev).
telnyx_enabled     = true # telnyx-api-key and telnyx-public-key pushed 2026-11-17
accept_api_enabled = false
sentry_enabled     = true # sentry-dsn pushed 2026-11-11
# home_assistant_url = "https://<instance>.ui.nabu.casa"

# The committed test recording until a real one exists:
#   just media push dev media/placeholder-accepted.wav --name accepted.wav
recording_accepted = "accepted.wav"

# Who may run just secrets-push and just media push against dev. Find an object ID
# with: az ad user show --id <upn> --query id -o tsv
maintainer_principal_ids = {
  ninjalikescheez = "c98fe67e-0682-49d6-85cf-cc9946647392" # NinjaLikesCheez@pixelbar.nl
}

# A starting point for prod's settings. prod is applied with terraform.tfvars
# (gitignored), shared through Key Vault: `just pull prod`, edit, `just push prod`
# (docs/runbook.md#terraform-settings). None of these are secrets.

pixel_principal_id = "69f18339-4484-400e-bb3e-e51164182d72" # Pixel prod's app identity

# Features stay off until their secrets are in Key Vault (just secrets-push prod).
# Never copy dev's values: prod gets its own Telnyx key, Home Assistant token and API keys.
telnyx_enabled     = false
accept_api_enabled = false
sentry_enabled     = false
# home_assistant_url = "https://<instance>.ui.nabu.casa"

# The real accept recording: just media push prod <file> --name accepted.mp3
recording_accepted = "accepted.mp3"

# Add "phone.pixelbar.nl" only after its CNAME and asuid TXT records exist
# (infra/envs/prod/README.md). Applying it needs the az CLI, signed in.
custom_domains = []

# Who may run just secrets-push and just media push against prod. Find an object ID
# with: az ad user show --id <upn> --query id -o tsv
maintainer_principal_ids = {
  ninjalikescheez = "c98fe67e-0682-49d6-85cf-cc9946647392" # NinjaLikesCheez@pixelbar.nl
}

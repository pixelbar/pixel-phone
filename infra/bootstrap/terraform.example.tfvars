# Copy to terraform.tfvars only if you need to override a default.
# terraform.tfvars is gitignored. None of these values are secrets.

subscription_id       = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"
location              = "westeurope"
prefix                = "pixel-phone"
github_repository     = "pixelbar/pixel-phone"
state_storage_account = "pixelbartfstate"

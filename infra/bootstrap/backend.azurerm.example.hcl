# The shared state account from Pixel's bootstrap. Create the container once
# by hand before the first init (see README.md).
resource_group_name  = "pixel-bootstrap"
storage_account_name = "pixelbartfstate"
container_name       = "pixel-phone-bootstrap"
key                  = "terraform.tfstate"
use_azuread_auth     = true
subscription_id      = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"

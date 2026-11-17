# Remote state for the dev stack. infra/bootstrap created the container.
resource_group_name  = "pixel-bootstrap"
storage_account_name = "pixelbartfstate"
container_name       = "pixel-phone-dev"
key                  = "terraform.tfstate"
use_azuread_auth     = true
subscription_id      = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4"

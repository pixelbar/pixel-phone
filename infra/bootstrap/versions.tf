terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  # Settings in backend.azurerm.example.hcl:
  # terraform init -backend-config=backend.azurerm.example.hcl
  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.8"
    }
  }
}

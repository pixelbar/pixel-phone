# 0010. Terraform bootstrap and GitHub OIDC

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

As for Pixel ([Pixel ADR 0008](https://github.com/pixelbar/pixel/blob/main/docs/adr/0008-terraform-bootstrap.md)), Terraform state must not live on a laptop, and GitHub Actions must not hold an Azure password. Pixel's bootstrap already created the `pixelbartfstate` storage account, which spacestate also uses.

## Decision

- **State in `pixelbartfstate`** (resource group `pixel-bootstrap`), in containers `pixel-phone-bootstrap`, `pixel-phone-dev` and `pixel-phone-prod`, with Azure AD auth.
- **`infra/bootstrap`** is applied by hand by a subscription Owner. It creates resource groups `pixel-phone-bootstrap` (for identities), `pixel-phone-dev` and `pixel-phone-prod`, and one user-assigned identity per environment for GitHub Actions.
- Each identity is **federated only to this repository's immutable OIDC subject** for its GitHub Environment, `repo:pixelbar@1690472/pixel-phone@1453907426:environment:<env>`, and is **Contributor on its own environment's resource group** only.
- Env stacks deploy into those groups and don't create them. No Terraform apply runs from CD.

## Consequences

- Someone with Owner runs the first apply and creates GitHub Environments `dev` and `prod` (required reviewers on `prod`).
- Contributor can't create role assignments, so applies that add them (every env stack does) are run by a maintainer, not by CI.

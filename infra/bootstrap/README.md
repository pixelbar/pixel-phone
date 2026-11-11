# Terraform bootstrap (#3)

One-time foundation: resource groups, a place for each environment's Terraform state, and GitHub Actions identities that log in to Azure without a client secret ([ADR 0010](../../docs/adr/0010-terraform-bootstrap-and-oidc.md)).

Applied **by hand**, from a laptop, by someone with **Owner** on the Pixelbar subscription. No workflow applies it.

## What it creates

In West Europe, subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`:

| Resource | Name |
| --- | --- |
| Resource groups | `pixel-phone-bootstrap`, `pixel-phone-dev`, `pixel-phone-prod` |
| State containers in `pixelbartfstate` | `pixel-phone-dev`, `pixel-phone-prod` |
| User-assigned identities (in `pixel-phone-bootstrap`) | `pixel-phone-github-dev`, `pixel-phone-github-prod` |

The state account `pixelbartfstate` belongs to Pixel's bootstrap and is shared with spacestate; this stack only reads it and adds containers.

Each GitHub identity federates only from this repository's matching GitHub Environment, using GitHub's immutable OIDC subject `repo:pixelbar@1690472/pixel-phone@1453907426:environment:<env>`. It is Contributor on that environment's resource group and Storage Blob Data Contributor on that environment's state container, and nothing else.

## Before the first apply

1. Azure CLI and Terraform 1.9 or later. Sign in as an Owner of the subscription:

   ```sh
   az login
   az account set --subscription d150e252-e2f0-47fb-8a4a-c3f29e9aebd4
   ```

2. You need a Storage Blob Data role on `pixelbartfstate` (shared keys are off). Pixel's bootstrap gave its applier Storage Blob Data Owner.

3. Create this stack's own state container, once:

   ```sh
   az storage container create --account-name pixelbartfstate --name pixel-phone-bootstrap --auth-mode login
   ```

## Apply

```sh
just tf-bootstrap plan
just tf-bootstrap apply
```

Keep the output: `tenant_id` and `github_client_ids` go into GitHub.

## GitHub Environments

In **Settings → Environments**, create `dev` and `prod`. On `prod`, require reviewers and limit deployments to `main`. In each, set these **variables** (not secrets):

| Variable | Value |
| --- | --- |
| `ARM_CLIENT_ID` | that environment's `github_client_ids` output |
| `ARM_TENANT_ID` | `tenant_id` output |
| `ARM_SUBSCRIPTION_ID` | `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4` |

A workflow job that doesn't use the environment can't log in.

Applied values (2026-11-11). Both environments exist, `prod` has a required reviewer and deploys from `main` only:

| Variable | `dev` | `prod` |
| --- | --- | --- |
| `ARM_CLIENT_ID` | `67fca063-44cd-487a-bb54-ad71f0d89f12` | `23d9148f-5406-480d-bdc5-3ea295b91383` |
| `ARM_TENANT_ID` | `2cd2bab0-0dd0-41ff-8f13-592500857ea6` | same |
| `ARM_SUBSCRIPTION_ID` | `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4` | same |

## Recover

- **Lost state:** the state account has versioning and soft delete. Restore the previous blob in `pixel-phone-bootstrap`.
- **Revoke GitHub's Azure access:** delete the federated credential or the identity. Workflows then fail closed; there is no password to rotate.

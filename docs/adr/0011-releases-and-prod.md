# 0011. Releases promote prod; phone.pixelbar.nl is bound like spacestate's domains

* Status: accepted
* Date: 2026-11-18
* Issue: #20

## Context

dev is rolled by hand (`just deploy dev`, **Deploy dev**). prod answers the real doorbell, so a change must reach it only when a person decides, and only a version that passed `just check`. Pixel solved this in [its ADR 0013](https://github.com/pixelbar/pixel/blob/main/docs/adr/0013-release-workflow.md); spacestate binds its custom domains with a managed certificate. ADR 0003 already says prod uses `phone.pixelbar.nl` and that deploys swap the image without Terraform.

## Decision

- **`infra/envs/prod`** is the same module as dev, in `pixel-phone-prod`, with Key Vault purge protection on and the real ringing helper (`input_boolean.pixel_phone_ringing`). Pixel prod's identity reads `phone-events`. A maintainer applies it from a laptop (`PIXEL_PHONE_APPLY_PROD=1 just tf-apply prod`); nothing applies from CI. Terraform seeds the app with `:main` and ignores the image afterwards.
- **Merges to `main` don't touch prod.** CD only publishes `:<sha>` and `:main`.
- **A person cuts a release:** the Release workflow (`workflow_dispatch` on `main`, or `just release`) runs `just check`, then `just bump --commit`, pushes the `Release vX.Y.Z` commit and tag, opens a GitHub Release, rebuilds the image from that commit as `:<sha>`, `:vX.Y.Z` and `:main`, makes the Sentry release (environment `prod`) and publishes the docs site. Its `prod-cd` job runs in GitHub Environment `prod` (required reviewer, `main` only) and rolls `pixel-phone-prod` to `:<sha>` with `az containerapp update`, then waits for `/version` to report that SHA.
- **Rollback** swaps the image back: `just rollback prod <sha or vX.Y.Z>`. Every released image stays on GHCR.
- **`phone.pixelbar.nl`** gets a free managed certificate validated by CNAME, bound in three steps in one apply (attach the hostname, issue the certificate, bind it) through `hostname.sh`, copied from spacestate. DNS is outside Azure, so the CNAME and `asuid` TXT records are made by hand first.
- **CI doesn't plan prod.** Environment `prod` deploys from `main` only and needs an approval, so a pull request can't use its identity. CI still validates the prod stack; a maintainer runs `just tf-plan prod`.

## Consequences

- Unreleased changelog entries collect on `main` until someone runs Release.
- A release replaces prod's only replica, so a call during the roll can be missed (ADR 0003). Release outside opening hours.
- Applying a stack with a custom domain needs the az CLI on the laptop (`hostname.sh`).
- If the job fails after the tag exists, **Re-run failed jobs** carries on with the same version.

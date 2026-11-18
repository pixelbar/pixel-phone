# 0012. Terraform settings in Key Vault, synced with `just pull` / `just push`

* Status: accepted
* Date: 2026-11-18

## Context

Each environment's settings (feature switches, `home_assistant_url`, `recording_accepted`, `pixel_principal_id`, the maintainers, prod's `custom_domains`) were committed as `infra/envs/<env>/terraform.example.tfvars`, and `just tf-plan` and `just tf-apply` read that file.

Pixel works differently. It keeps a gitignored `terraform.tfvars` per environment in a Key Vault secret, `terraform-tfvars`, and maintainers sync it with `just pull <env>` and `just push <env>` (Pixel ADRs 0015 and 0017). The same people run both projects, and pixel-phone follows Pixel's conventions (AGENTS.md).

## Decision

- Each environment is planned and applied with `infra/envs/<env>/terraform.tfvars`, which is gitignored. `just tf-plan` and `just tf-apply` stop if it's missing.
- It's shared through the Key Vault secret `terraform-tfvars`, listed in `infra/secrets.manifest.yaml` under a new `tooling` group. Existing secrets are in the `app` group. Terraform reads only the `app` group.
- `just pull <env>` and `just push <env>` sync the tfvars and the app secrets together. `just secrets-pull` and `just secrets-push` still sync only the app secrets. The tfvars is shown as a diff. A push refuses a tfvars that sets a sensitive variable or one the stack doesn't declare. It re-reads the vault before writing and reads the values back afterwards. It never applies.
- `terraform.tfvars` holds settings, never secrets. A secret Terraform input, if one is ever needed, goes in a gitignored `secrets.auto.tfvars` that never leaves the laptop.
- `terraform.example.tfvars` stays committed as the starting point for a new environment, and CI plans dev with it.

## Consequences

- Changing a setting is pull, edit, push, plan, apply. It's no longer a pull request, so the change has no review and no history in git. Key Vault keeps every version of the secret.
- CI's plan of dev uses the example, so it can differ from what dev is really applied with. Keep the example close to dev's settings.
- A new environment starts from a copy of the example, because its Key Vault exists only after the first apply. It's pushed after that.
- Before a plan, a maintainer runs `just pull <env>`. An old local copy would undo someone else's change.

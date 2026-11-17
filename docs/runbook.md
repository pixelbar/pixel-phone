# Runbook

How to run pixel-phone. Sections are filled in as the pieces land.

## Deploying

| What | How |
| --- | --- |
| A merge to `main` | CD publishes `ghcr.io/pixelbar/pixel-phone:<sha>` and `:main`, and a Sentry release if `SENTRY_AUTH_TOKEN` is set. It never touches Azure |
| A branch or PR onto dev | **Actions → Deploy dev → Run workflow**, or `just deploy-remote dev <branch or PR number>`. Runs `just check`, publishes `:<sha>` and `:dev`, and rolls `pixel-phone-dev` |
| This working tree onto dev | `just deploy dev`. Needs Docker, `az login`, and `gh auth refresh -s write:packages` once |
| prod | The Release workflow (#20) |

Deploys replace whatever dev runs. Say so in the team chat first.

**Dev URL:** `https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io`. The Telnyx webhook is `/webhooks/telnyx` on it.

**Rollback:** `az containerapp update -g pixel-phone-dev -n pixel-phone-dev --image ghcr.io/pixelbar/pixel-phone:<previous sha>`.

**Always warm:** each environment runs exactly one replica and never scales to zero (ADR 0003, amended by #29). A cold start measured 24.9 s on 2026-11-11, longer than the 15 s accept window. A deploy still replaces the replica, so a call during a roll can be missed: deploy outside opening hours.

## Secrets

Secrets live in each environment's Key Vault (`pixel-phone-dev-kv`, `pixel-phone-prod-kv`). [`infra/secrets.manifest.yaml`](../infra/secrets.manifest.yaml) is the list. Only `just secrets-push` writes them; Terraform only references them, so no value ever reaches Terraform state.

| Key Vault name | Environment variable | Feature | What it is |
| --- | --- | --- | --- |
| `telnyx-api-key` | `TELNYX_API_KEY` | `telnyx` | Telnyx API key for Call Control commands |
| `telnyx-public-key` | `TELNYX_PUBLIC_KEY` | `telnyx` | The Telnyx account's Ed25519 public key (Mission Control → Keys & Credentials → Public Key) |
| `home-assistant-token` | `HOME_ASSISTANT_TOKEN` | `home-assistant` | Long-lived token of a non-admin Home Assistant user |
| `api-keys-yaml` | `API_KEYS_YAML` | `accept-api` | The accept API's callers, a YAML list of `id` and `key` |
| `sentry-dsn` | `SENTRY_DSN` | `sentry` | The Sentry project's DSN |

To set or change one:

1. Put the value in `.env.dev` (or `.env.prod`), with `PIXEL_PHONE_ENV=dev` (or `prod`) in the same file.
2. `just secrets-push dev`: shows which secrets change (never the values) and asks first. It never deletes.
3. If the secret's feature is off, turn it on in `infra/envs/dev/terraform.example.tfvars` and `just tf-apply dev`. Turning a feature on before its secrets exist stops new revisions from starting.
4. Otherwise `just restart dev`: the Container App reads secrets when a revision starts.

`just secrets-pull dev` goes the other way, after showing what changes. `just validate-secrets` checks the manifest.

## Telnyx

| | dev | prod |
| --- | --- | --- |
| Number | `+31103024128` (until prod has its own, #21) | not ordered yet |
| Call Control application | `pixel-phone-dev` | `pixel-phone-prod` (#20) |
| Webhook URL | `https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io/webhooks/telnyx` | `https://phone.pixelbar.nl/webhooks/telnyx` |

### Pointing a number at an environment

Until `just telnyx-sync` (#8) does this, it's done in the Telnyx portal:

1. **Voice → Programmable Voice → Call Control Applications → Add new App**, named `pixel-phone-dev`.
2. **Webhook URL:** the environment's URL above, method POST, **API version 2**.
3. Turn **first command timeout off**. pixel-phone sends no command until someone accepts (ADR 0002), and Telnyx must not drop a call that is waiting.
4. Save, then **Numbers → My Numbers → the number → Connection or App:** choose `pixel-phone-dev`.
5. **Keys & Credentials → Public Key:** copy the account's Ed25519 public key into `.env.dev` as `TELNYX_PUBLIC_KEY`. Webhook signatures are checked against it from #9 onwards.
6. Call the number. The dev logs should show `telnyx.webhook_stub` with `eventType: call.initiated`. Until #10 nothing answers, so the call just rings.

## Home Assistant

## When the doorbell doesn't ring

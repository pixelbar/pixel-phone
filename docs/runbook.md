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
| Call Control application | `Pixel Phone` (made in the portal) | `pixel-phone-prod` (#20) |
| Webhook URL | `https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io/webhooks/telnyx` | `https://phone.pixelbar.nl/webhooks/telnyx` |

### `just telnyx-sync`: the application and numbers as code

[`config/telnyx.<env>.yaml`](../config) says what the Telnyx side should be: the application's name, its numbers, and (for prod) the webhook host. `just telnyx-sync <env>` makes Telnyx match ([ADR 0007](adr/0007-telnyx-config-by-script.md)):

- the application's webhook URL is `https://<host>/webhooks/telnyx` (and a failover URL if `failover_host` is set), API version 2, **first command timeout off**, active, and an inbound channel limit of 2;
- every listed number points at that application.

It reads `TELNYX_API_KEY` from `.env.<env>` (or Key Vault with `--from-vault`) and the host from the Container App (`az containerapp show`) unless the file sets `host`. It prints what would change and asks first. It never prints the key.

| Command | What it does |
| --- | --- |
| `just telnyx-sync dev --dry-run` | Shows what would change, writes nothing |
| `just telnyx-sync dev` | Shows the change and asks before writing |
| `just telnyx-sync dev --check` | Exits 1 if someone changed something in the portal (drift) |
| `just telnyx-sync dev --yes` | Writes without asking (dev only; prod also needs `PIXEL_PHONE_SYNC_PROD=1`) |

**Run it** after the environment's hostname changes (a new Container App, or `phone.pixelbar.nl` for prod), after adding or moving a number in `config/telnyx.<env>.yaml`, and whenever `--check` reports drift. Running it twice changes nothing the second time.

**Public key:** webhook signatures are checked against the account's Ed25519 public key (**Keys & Credentials → Public Key** in the portal), stored as `telnyx-public-key`. The sync doesn't manage it; it changes only if Telnyx rotates it.

### Webhooks

Every request to `/webhooks/telnyx` must carry a valid Ed25519 signature (`telnyx-signature-ed25519` over `telnyx-timestamp|body`) made within the last five minutes. What the logs say:

| Log `event` | Meaning |
| --- | --- |
| `telnyx.webhook` | A verified event, handed to the call flow |
| `telnyx.webhook_duplicate` | Telnyx sent an event ID again; acknowledged, not handled twice |
| `telnyx.webhook_rejected` (`reason`) | 401. `bad_signature`: wrong `TELNYX_PUBLIC_KEY`, or not Telnyx. `stale_timestamp`: replay, or the clock is off. `missing_headers`: not Telnyx |
| `telnyx.webhook_ignored` (debug) | A Telnyx event type we don't act on |
| `telnyx.webhook_unconfigured` | 503: Telnyx isn't configured (`telnyx_enabled` off) |

**Every webhook is rejected with `bad_signature`:** the public key in Key Vault doesn't match the account. Copy it again from **Keys & Credentials → Public Key**, `just secrets-push dev`, `just restart dev`.

Event IDs are kept in the `WebhookEvents` table for two days, then pruned.

## Calls

Each call is a row in the `Calls` table: partition = the UTC day, row = the call ID (`20261118-3f9a1c2b7d4e`). Rows are kept 90 days. The states are in the [README](../README.md#call-states).

| Status | Meaning |
| --- | --- |
| `ringing` | Waiting for an accept. No command has been sent to Telnyx |
| `accepting` | Someone accepted: answered, playing the recording |
| `ended` | `endedReason`: `playback_finished` (normal), `caller_hung_up` (during the recording), `abandoned` (no Telnyx event for 3 minutes after the accept) |
| `missed` | `missedReason`: `timeout` (nobody accepted within `ACCEPT_WINDOW_SECONDS`) or `caller_hung_up`. Never answered, so OpenR moved on |
| `busy` | Arrived while another call was active. Never answered: it rings out and OpenR moves on |

**One call at a time.** A second doorbell call while one is `ringing` or `accepting` is `busy` and gets no command, so OpenR moves on to its next number. We don't send a SIP busy: OpenR only moves on after *no answer*, and a busy might not count (decided for #11).

**Stuck calls can't block the doorbell.** A `ringing` call past its window, or an `accepting` call with no event for 3 minutes, is retired when the next call arrives and on startup.

**OpenR's ring time per number** bounds how long anyone has to accept: if it is shorter than `ACCEPT_WINDOW_SECONDS` (15 s), OpenR gives up first. **Not measured yet.** To measure: call the dev number from OpenR (press the doorbell with only the dev number on its list), don't accept, and read the gap between `call.initiated` and `call.hangup` in the logs. Record it here.

### Looking at calls

```sh
az storage entity query --account-name pixelphonedevst --auth-mode login -t Calls \
  --filter "PartitionKey eq '$(date -u +%Y-%m-%d)'" -o table
```

## Pixel and the queue

pixel-phone publishes call events to the `phone-events` queue; Pixel reads them. The contract is [docs/events.md](events.md). Messages expire after five minutes.

Peek without taking them (needs the maintainer read role from `just tf-apply dev`):

```sh
az storage message peek --queue-name phone-events --account-name pixelphonedevst \
  --auth-mode login --num-messages 32 -o json | jq -r '.[].content'
```

A publish has three seconds. A failure is logged as `queue.failed` and sent to Sentry (`area: queue`); Home Assistant still rings. If both fail, the call rings out and OpenR moves on.

Changing the contract: edit `src/core/events.ts`, `just events-schema`, update `docs/events.md`, and tell Pixel's maintainers. A breaking change is a new `version`.

## Home Assistant

Home Assistant owns the siren ([ADR 0005](adr/0005-home-assistant-owns-the-siren.md)). pixel-phone only turns a helper on while a call rings and off when it stops ringing; Home Assistant's own automations decide whether the siren sounds, and may turn the helper off themselves.

| | dev | prod |
| --- | --- | --- |
| Helper | `input_boolean.pixel_phone_ringing_dev` (nothing is attached to it) | `input_boolean.pixel_phone_ringing` |
| URL | the Nabu Casa URL, `home_assistant_url` in `infra/envs/<env>/terraform.example.tfvars` | same |

Config refuses a non-`_dev` helper outside prod, and Terraform pins dev's helper.

### Connecting an environment

1. In Home Assistant, **Settings → Devices & services → Helpers → Create helper → Toggle**, named `pixel_phone_ringing_dev` (so its ID is `input_boolean.pixel_phone_ringing_dev`).
2. **Settings → People → Users → Add user** `pixel-phone` (not an administrator). Log in as it once, then **Profile → Security → Long-lived access tokens → Create token**.
3. Put the token in `.env.dev` as `HOME_ASSISTANT_TOKEN`, then `just secrets-push dev`.
4. Set `home_assistant_url` in `infra/envs/dev/terraform.example.tfvars` and `just tf-apply dev`.
5. Check: `curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"entity_id":"input_boolean.pixel_phone_ringing_dev"}' https://<nabu casa url>/api/services/input_boolean/turn_on` flips the helper on. Turn it off the same way.

Each call has three seconds and no retry. A failure is logged as `home-assistant.failed` and sent to Sentry with the tag `area: home-assistant`; the call still reaches Pixel through the queue.

Without `home_assistant_url`, pixel-phone logs `ringer.off` instead of ringing.

| `home-assistant.failed` says | Fix |
| --- | --- |
| `401 (is HOME_ASSISTANT_TOKEN valid?)` | The token was revoked or mistyped: make a new one (step 2), push, restart |
| `400` / `404 (does input_boolean… exist…)` | The helper is missing or renamed (step 1) |
| `didn't get through (TimeoutError)` | Home Assistant or Nabu Casa is down or slow |

## When the doorbell doesn't ring

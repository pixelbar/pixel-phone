# Runbook

How to run pixel-phone day to day. To build an environment from an empty subscription, start with [Setting up from nothing](setup.md).

## Deploying

| What | How |
| --- | --- |
| A merge to `main` | CD publishes `ghcr.io/pixelbar/pixel-phone:<sha>` and `:main`, and a Sentry release if `SENTRY_AUTH_TOKEN` is set. It never touches Azure |
| A branch or PR onto dev | **Actions → Deploy dev → Run workflow**, or `just deploy-remote dev <branch or PR number>`. Runs `just check`, publishes `:<sha>` and `:dev`, and rolls `pixel-phone-dev` |
| This working tree onto dev | `just deploy dev`. Needs Docker, `az login`, and `gh auth refresh -s write:packages` once |
| prod | A release: `just release` (or **Actions → Release → Run workflow** on `main`), then approve **prod**. See [Releasing](#releasing) |
| Back to an earlier image | `just rollback <env> <sha or vX.Y.Z>`. See [Rolling back](#rolling-back) |

Deploys replace whatever dev runs. Say so in the team chat first.

| | dev | prod |
| --- | --- | --- |
| URL | `https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io` | `https://phone.pixelbar.nl` (and the app's own `*.azurecontainerapps.io` name, the `fqdn` output) |
| Telnyx webhook | `/webhooks/telnyx` on it | `https://phone.pixelbar.nl/webhooks/telnyx` |
| Ringing helper | `input_boolean.pixel_phone_ringing_dev` (nothing attached) | `input_boolean.pixel_phone_ringing` |

**Always warm:** each environment runs exactly one replica and never scales to zero (ADR 0003, amended by #29). A cold start measured 24.9 s on 2026-11-11, longer than the 15 s accept window. A deploy still replaces the replica, so a call during a roll can be missed: deploy outside opening hours.

### Releasing

A release is the only way code reaches prod ([ADR 0011](adr/0011-releases-and-prod.md)). Merges collect under `## [Unreleased]` in `CHANGELOG.md` until someone releases.

1. Outside opening hours, `just release` (or **Actions → Release → Run workflow** on `main`).
2. The workflow runs `just check`, cuts `[Unreleased]` into `vX.Y.Z` (`just bump --commit`: Added → minor, Fixed/Changed → patch), pushes the `Release vX.Y.Z` commit and tag, opens a GitHub Release, publishes `ghcr.io/pixelbar/pixel-phone:<sha>`, `:vX.Y.Z` and `:main`, makes the Sentry release (environment `prod`) and publishes the docs site.
3. **Roll pixel-phone-prod** waits for a reviewer on Environment `prod`. Approve it in the run (**Review deployments**). It runs `az containerapp update` to `:<sha>` and waits until `/version` reports that SHA. Its summary names the release to roll back to, if prod ran one before. The first release replaces the unpinned `:main` that Terraform created prod with, so it has nothing to roll back to.
4. Check: `curl -sS https://phone.pixelbar.nl/version`, and the logs for `process.started`.

If a job fails after the tag exists, **Re-run failed jobs**: it carries on with the same version. "No Unreleased notes" means there is nothing to release. Rejecting the approval leaves prod as it was; the version, image and GitHub Release stay.

The workflow never applies Terraform. An infra change is `PIXEL_PHONE_APPLY_PROD=1 just tf-apply prod` from a laptop, after `just tf-plan prod`.

### Rolling back

```sh
just rollback prod v0.3.0          # or the previous commit SHA
```

It takes only a full commit SHA or a `vX.Y.Z` tag (`:main` and `:dev` move with every publish). It checks the app says `PIXEL_PHONE_ENV=prod` and that the image can be pulled, asks you to type `prod`, swaps the image (secrets and Terraform are untouched) and waits for the new revision. The previous release is on the [releases page](https://github.com/pixelbar/pixel-phone/releases), or in the summary of the release that broke things. Without `just`: `az containerapp update -g pixel-phone-prod -n pixel-phone-prod --image ghcr.io/pixelbar/pixel-phone:<previous sha>`.

A rollback isn't recorded anywhere but Azure: say so in the team chat, and fix forward with a new release. dev is the same with `just rollback dev <sha>`.

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
3. If the secret's feature is off, turn it on in `infra/envs/dev/terraform.tfvars` ([Terraform settings](#terraform-settings)), `just push dev` and `just tf-apply dev`. Turning a feature on before its secrets exist stops new revisions from starting.
4. Otherwise `just restart dev`: the Container App reads secrets when a revision starts.

`just secrets-pull dev` goes the other way, after showing what changes. `just pull dev` and `just push dev` do the same and also sync the Terraform settings. `just validate-secrets` checks the manifest.

**prod never gets dev's values.** `.env.prod` is its own file, and `just secrets-push prod` refuses a file that says `PIXEL_PHONE_ENV=dev`. Prod pushes always ask you to type `prod`.

### Rotating a secret

Each one the same way: put the new value in `.env.<env>`, `just secrets-push <env>`, `just restart <env>`, check, then revoke the old value. Between the restart and updating a caller, that caller fails, so rotate outside opening hours.

| Secret | Where the new value comes from | Check, then revoke the old one |
| --- | --- | --- |
| `telnyx-api-key` | Telnyx portal → **Keys & Credentials → API Keys → Create** (one key per environment, so either can be revoked alone) | `just telnyx-sync <env> --check --from-vault` passes; delete the old key in the portal |
| `telnyx-public-key` | **Keys & Credentials → Public Key**. It is the account's, the same for dev and prod, and changes only if Telnyx rotates it | The next call logs `telnyx.webhook`, not `bad_signature` |
| `home-assistant-token` | A new token for the `pixel-phone` user ([Home Assistant](home-assistant.md#connecting-an-environment), step 2), named after the environment | Step 5 there flips the helper; delete the old token on the user's profile |
| `api-keys-yaml` | `just api-key <caller>` for the caller being rotated, replacing only its line | Update the caller (Home Assistant's `secrets.yaml`, Pixel's Key Vault), then a test accept answers `404` with nothing ringing |
| `sentry-dsn` | Sentry → project `pixel-phone` → **Client Keys (DSN)** → new key | The logs show `process.started` and no Sentry warning; disable the old key in Sentry |

A leaked value: rotate it at once, even in opening hours. The doorbell keeps working through a Telnyx or Home Assistant rotation, because a failure there only means the call rings out.

### Terraform settings

Each environment is applied with its `infra/envs/<env>/terraform.tfvars`: feature switches, `home_assistant_url`, `recording_accepted`, `pixel_principal_id`, the maintainers, prod's `custom_domains`. It is gitignored. Every maintainer gets the same copy from the Key Vault secret `terraform-tfvars` (the manifest's `tooling` group), as Pixel does ([ADR 0012](adr/0012-tfvars-in-key-vault.md)).

| | Local | Shared through | Diff shown |
| --- | --- | --- | --- |
| App secrets | `.env.<env>` | Key Vault, one secret each (the `app` group) | No, names and lengths only |
| Terraform settings | `infra/envs/<env>/terraform.tfvars` | Key Vault secret `terraform-tfvars` (the `tooling` group) | Yes |

To change a setting:

1. `just pull dev`: brings `terraform.tfvars` and `.env.dev` up to date, showing what changes and asking first.
2. Edit `infra/envs/dev/terraform.tfvars`.
3. `just push dev`: shows the diff against Key Vault and asks. It re-reads the vault before writing, so a push made by someone else in the meantime stops it, and reads every value back afterwards.
4. `just tf-plan dev`, then `just tf-apply dev`. A push applies nothing.

For prod, the same with `prod`; pushing asks you to type `prod`.

**`terraform.tfvars` holds settings, never secrets.** App secrets aren't Terraform inputs at all. Should a stack ever need a secret input (a variable marked `sensitive`), it goes in `infra/envs/<env>/secrets.auto.tfvars`: Terraform loads it by itself, it's gitignored, and it never leaves your laptop. `just push` refuses a tfvars that sets a sensitive variable or one the stack doesn't declare (prod's `custom_domains` in dev's file shows it's the wrong one). It checks before showing anything, and the diff hides every sensitive value.

**`terraform.example.tfvars`** stays committed: CI plans dev with it on pull requests, and it's where a new environment starts. Keep it close to dev's real settings so the PR plan means something.

**First time for an environment** (or before its Key Vault exists): `cp infra/envs/<env>/terraform.example.tfvars infra/envs/<env>/terraform.tfvars`, check it, plan and apply. Once the vault exists, `just push <env>` shares it. `just pull` says when Key Vault has no `terraform-tfvars` yet.

## Telnyx

| | dev | prod |
| --- | --- | --- |
| Number | `+31103024128` (until prod has its own, #21) | not ordered yet |
| Call Control application | `Pixel Phone` (made in the portal) | `pixel-phone-prod`, made by `just telnyx-sync prod` |
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

## Testing locally

`just azurite`, then `just simulate-call [options]` (see the [README](../README.md#try-it-first)). It runs the real app with a fresh test key pair, a fake Telnyx and a fake Home Assistant, and Azurite for storage. Nothing leaves the laptop. `HARNESS_DEBUG=1` also prints the app's own log lines. CI runs six scenarios on every pull request.

If a run says "no outcome" with no `call.ringing`, the app dropped the webhook: run with `HARNESS_DEBUG=1`. To start from empty storage, `just azurite-stop && just azurite`.

## Testing a real call on dev

What has to be in place, once:

| | How | Check |
| --- | --- | --- |
| The app is deployed | `just deploy dev` (or **Deploy dev** for a branch) | `curl https://<dev url>/version` shows the commit |
| Telnyx points at dev | `just telnyx-sync dev` | `just telnyx-sync dev --check` passes |
| A recording | `just media push dev media/placeholder-accepted.wav --name accepted.wav` | `just media list dev` |
| An accept key | `just api-key home-assistant` → `API_KEYS_YAML` in `.env.dev` → `just secrets-push dev`; `accept_api_enabled = true` in the tfvars, `just push dev`; `just tf-apply dev` | `curl -X POST -H "Authorization: Bearer $KEY" https://<dev url>/api/v1/calls/current/accept` answers 404 |
| Home Assistant (optional) | [Connecting an environment](home-assistant.md#connecting-an-environment) | the `_dev` helper flips during a call |

Then:

1. **Missed call.** Call `+31103024128` from a phone and don't accept. You hear ringing; after 15 s nothing changes (no command was sent), and the logs show `call.ringing` then `call.missed` (`reason: timeout`). Hang up.
2. **Caller hangs up.** Call, hang up within 15 s: `call.missed` with `reason: caller_hung_up`.
3. **Accepted.** Call, and within 15 s run the accept `curl` above. It answers `202 {"callId":…}`; the phone is picked up and plays the test recording, then hangs up. Logs: `call.ringing`, `accept.accepted`, `call.accepted`, `call.answered_by_telnyx`, `call.ended` (`reason: playback_finished`).
4. **Too late.** Call, wait 16 s, accept: `410`, and the phone keeps ringing.
5. **Busy.** While one call rings, call from a second phone: `call.busy`; the second call just rings.

Reading the logs:

```sh
az containerapp logs show -g pixel-phone-dev -n pixel-phone-dev --follow --format text | grep -E '"event":"(call|accept|telnyx|home-assistant|queue|media)\.'
```

Every outcome is one `call.<outcome>` line with `callId`, `from`, `to` and `via`/`by`. A failing dependency is `<area>.failed` and a Sentry issue tagged `area`.

## Setting up prod

[Setting up from nothing](setup.md#_5-prod) has the steps, in order, from the first apply to the prod number.

## Calls

Each call is a row in the `Calls` table: partition = the UTC day, row = the call ID (`20261118-3f9a1c2b7d4e`). Rows are kept 90 days. The states are in the [overview](index.md#call-flow).

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

## Recordings

The only recording is the accept recording ("someone is on their way to let you in"), played after someone accepts ([ADR 0008](adr/0008-recordings-in-blob-storage.md)). It lives in the environment's private `media` container; `RECORDING_ACCEPTED` names the blob (`recording_accepted` in Terraform, default `accepted.mp3`). For each accepted call the app signs a read-only URL that lasts 15 minutes and hands it to Telnyx. Nothing is public.

| Command | What it does |
| --- | --- |
| `just media push dev <file> --name accepted.mp3` | Uploads (or replaces) a recording, after checking it's MP3 or WAV and the name's extension matches. Prod asks first |
| `just media list dev` | Lists the recordings |

Changing a recording needs **no deploy**: the next accepted call plays the new file. Changing its *name* is a Terraform setting (`recording_accepted` in the tfvars, [Terraform settings](#terraform-settings)): `just push`, then `just tf-apply`.

**dev** plays the committed test recording, [`media/placeholder-accepted.wav`](../media/placeholder-accepted.wav) (a synthetic voice saying it's a test):

```sh
just media push dev media/placeholder-accepted.wav --name accepted.wav
```

**At startup** the app checks the recording exists. If not, it logs `media.failed` ("accept recording … is missing") and reports it to Sentry, and still starts: a call can still be accepted, but the caller hears silence before we hang up.

Checking a URL by hand (needs the maintainer role, which can also sign):

```sh
az storage blob generate-sas --account-name pixelphonedevst --container-name media --name accepted.wav \
  --permissions r --expiry $(date -u -v+15M +%Y-%m-%dT%H:%MZ) --auth-mode login --as-user --full-uri -o tsv
```

## The accept API

`POST /api/v1/calls/current/accept` (Home Assistant's button) and `POST /api/v1/calls/{callId}/accept` (Pixel), with `Authorization: Bearer <key>`. Responses are in [docs/events.md](events.md#the-accept-api) and [docs/openapi.yaml](openapi.yaml).

### Giving a caller a key

1. `just api-key home-assistant` prints a line like `- { id: home-assistant, key: … }`. It writes nothing.
2. Add the line to `API_KEYS_YAML` in `.env.dev`, keeping the other callers' lines. As one line: `API_KEYS_YAML='[{ id: home-assistant, key: … }, { id: pixel, key: … }]'`.
3. `just secrets-push dev`. The first time, also set `accept_api_enabled = true` in `infra/envs/dev/terraform.tfvars`, `just push dev` and `just tf-apply dev`; otherwise `just restart dev`.
4. Give the key to the caller: Home Assistant's `secrets.yaml`, or Pixel's Key Vault. Never in chat or an issue.

**Rotating:** make a new key for the same id, replace its line, push, restart, then update the caller. The old key stops working at the restart.

**Logs:** `accept.accepted` (with `via`, `by`, `callId`), `accept.already_accepted`, `accept.too_late`, `accept.no_call`, `accept.unauthorized` (a bad key; at most 30 lines a minute per address), `accept.rate_limited`. Keys are never logged.

### Trying it

```sh
curl -sS -X POST -H "Authorization: Bearer $KEY" \
  https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io/api/v1/calls/current/accept
```

With nothing ringing that answers `404 {"error":"no ringing call"}`, which proves the key works.

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

Connecting an environment, the accept button, the token and the planned automations are in [Home Assistant](home-assistant.md).

## The docs site

These pages are published at `https://pixelbar.nl/pixel-phone/` from `docs/` ([`docs/AGENTS.md`](AGENTS.md) explains the site).

| What | How |
| --- | --- |
| A pull request that touches `docs/` | The **Docs site** workflow lints and builds it. A dead link fails the build. Nothing is published |
| A release | The Release workflow calls **Docs site** with the release commit and publishes it |
| Republish without a release | **Actions → Docs site → Run workflow** on `main` |
| On a laptop | `just docs-install` once, then `just docs-dev` |
| Refresh the theme from pixelbar.nl/pixel | `just pixel-theme`, then commit `docs/.vitepress/theme/pixel.css` |

Before the first publish, a repository admin sets GitHub Pages to deploy from Actions, once:

```sh
gh api -X POST repos/pixelbar/pixel-phone/pages -f build_type=workflow
```

The site appears under `pixelbar.nl` because the organisation's Pages site (`pixelbar.github.io`) has that domain. Pages creates the `github-pages` environment, which deploys from `main` only.

## When the doorbell doesn't ring

Work from the outside in. Nothing here ever answers a call by itself: doing nothing lets the call ring out and OpenR try its next number.

| Symptom | Look at | Likely cause and fix |
| --- | --- | --- |
| No `telnyx.webhook` lines at all | `curl https://<url>/healthz`; Telnyx portal → the app → webhook URL; `just telnyx-sync <env> --check` | App down (roll back, see [Rolling back](#rolling-back)), or the webhook URL drifted (`just telnyx-sync <env>`) |
| prod: `phone.pixelbar.nl` fails but the `fqdn` output answers | `dig CNAME phone.pixelbar.nl`; `curl -v https://phone.pixelbar.nl/healthz` (certificate) | The CNAME or `asuid` TXT record was changed, or the certificate couldn't renew without them. Put the records back ([`infra/envs/prod/README.md`](../infra/envs/prod/README.md)). Meanwhile Telnyx uses `failover_host` if it is set |
| Broke right after a release | The release's run; `/version` | `just rollback prod <previous version>`, then fix forward |
| `telnyx.webhook_rejected` with `bad_signature` | Key Vault `telnyx-public-key` | Public key wrong: copy it from the portal, `just secrets-push`, `just restart` |
| `call.busy` for every call | `Calls` table: is a call stuck `ringing`/`accepting`? | Stuck calls retire on their own (15 s / 3 min). If not, `just restart <env>` recovers them |
| `call.ringing` but no siren | `home-assistant.failed` lines | Token or helper (see [Home Assistant](home-assistant.md)). If HA flipped the helper, it's HA's automation |
| `call.ringing` but nothing in Discord | `queue.failed` lines; Pixel's logs | Queue unreachable, or Pixel isn't polling |
| Accept answers 202 but the phone isn't picked up | `telnyx.failed` with `during: answer` | Telnyx API key wrong or expired; the call rings out. Fix the key, push, restart |
| Picked up but silent, then hangs up | `media.failed` | Recording missing (`just media list`) or the app can't sign URLs (Storage Blob Delegator) |
| `call.missed` with `caller_hung_up` straight away | The caller hung up, or OpenR's ring time is short | See OpenR's ring time under [Calls](#calls) |


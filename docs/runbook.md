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
| An accept key | `just api-key home-assistant` → `API_KEYS_YAML` in `.env.dev` → `just secrets-push dev`; `accept_api_enabled = true`; `just tf-apply dev` | `curl -X POST -H "Authorization: Bearer $KEY" https://<dev url>/api/v1/calls/current/accept` answers 404 |
| Home Assistant (optional) | [Connecting an environment](#connecting-an-environment) | the `_dev` helper flips during a call |

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

## Recordings

The only recording is the accept recording ("someone is on their way to let you in"), played after someone accepts ([ADR 0008](adr/0008-recordings-in-blob-storage.md)). It lives in the environment's private `media` container; `RECORDING_ACCEPTED` names the blob (`recording_accepted` in Terraform, default `accepted.mp3`). For each accepted call the app signs a read-only URL that lasts 15 minutes and hands it to Telnyx. Nothing is public.

| Command | What it does |
| --- | --- |
| `just media push dev <file> --name accepted.mp3` | Uploads (or replaces) a recording, after checking it's MP3 or WAV and the name's extension matches. Prod asks first |
| `just media list dev` | Lists the recordings |

Changing a recording needs **no deploy**: the next accepted call plays the new file. Changing its *name* is a Terraform change (`recording_accepted`) and `just tf-apply`.

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
3. `just secrets-push dev`. The first time, also set `accept_api_enabled = true` in `infra/envs/dev/terraform.example.tfvars` and `just tf-apply dev`; otherwise `just restart dev`.
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

Home Assistant owns the siren ([ADR 0005](adr/0005-home-assistant-owns-the-siren.md)). pixel-phone only turns a helper on while a call rings and off when it stops ringing; Home Assistant's own automations decide whether the siren sounds, and may turn the helper off themselves.

| | dev | prod |
| --- | --- | --- |
| Helper | `input_boolean.pixel_phone_ringing_dev` "Pixel Phone ringing (dev)" (nothing is attached to it) | `input_boolean.pixel_phone_ringing` "Pixel Phone ringing" |
| URL | the Nabu Casa URL, `home_assistant_url` in `infra/envs/<env>/terraform.example.tfvars` | same |
| Accept action | `rest_command.pixel_phone_accept_dev` | `rest_command.pixel_phone_accept` (with prod, #20) |
| Accept key in HA | `pixel_phone_dev_accept_authorization` in `secrets.yaml` | `pixel_phone_accept_authorization` |
| HA user | `pixel-phone`, not an administrator, one token per environment | same user |

Config refuses a non-`_dev` helper outside prod, and Terraform pins dev's helper.

**What is set up in Pixelbar's Home Assistant** (2026.9; #18, 2026-11-18):

| Item | State |
| --- | --- |
| Both helpers | Created on 2026-11-18. Nothing uses them yet |
| `pixel-phone` user and its tokens | Made by hand (step 2 below) |
| `rest_command.pixel_phone_accept_dev` | Made by hand (see [The button](#the-button)) |
| Siren automation | **Not yet:** Home Assistant has no siren. The WLED "Siren Party Light" (`light.wled`) is only a light |
| Button automation | **Not yet:** Home Assistant has no accept button |

### Connecting an environment

1. The helper exists (see the table above). If it is ever missing: **Settings → Devices & services → Helpers → Create helper → Toggle**, named `Pixel Phone ringing (dev)` (its ID becomes `input_boolean.pixel_phone_ringing_dev`).
2. **Settings → People → Users → Add user** `pixel-phone`, **not** an administrator, "Can only log in from the local network" off. Log in as it once in a private window, then **Profile → Security → Long-lived access tokens → Create token**, named after the environment (`pixel-phone dev`).
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

**What the token can do.** Home Assistant can't limit a token to some actions or entities: a non-admin user can still call any action on any entity, but can't change configuration, users or integrations. Not being an administrator is all the narrowing Home Assistant offers ([ADR 0005](adr/0005-home-assistant-owns-the-siren.md)). So the token is a Key Vault secret like the others, and only pixel-phone has it.

**Rotating the token:** log in as `pixel-phone`, create a new token, put it in `.env.<env>`, `just secrets-push <env>`, `just restart <env>`, check with step 5, then delete the old token on the same page. Do this too if someone leaves who had the user's password.

### The button

The button reaches pixel-phone through the accept API with the `home-assistant` key ([Giving a caller a key](#giving-a-caller-a-key)). The key is kept in Home Assistant's `secrets.yaml`, never in an automation.

`rest_command` exists only in YAML. With the **File editor** app, copy `configuration.yaml` and `secrets.yaml` first, then add to `secrets.yaml`:

```yaml
pixel_phone_dev_accept_authorization: "Bearer <the home-assistant key for dev>"
```

and to `configuration.yaml`:

```yaml
rest_command:
  pixel_phone_accept_dev:
    url: https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io/api/v1/calls/current/accept
    method: post
    headers:
      authorization: !secret pixel_phone_dev_accept_authorization
    content_type: application/json
    payload: '{"by":"button"}'
    timeout: 5
```

Then **Tools → YAML → Check configuration**, and reload **REST commands** (restart Home Assistant if it isn't listed). Prod gets `pixel_phone_accept`, with its own key and URL, when prod exists.

**Trying it:** in **Tools → Actions**, run `rest_command.pixel_phone_accept_dev` with **Return response** on. With nothing ringing, the response has `status: 404`; while a real call to the dev number rings, `status: 202` and the phone picks up. A `401` means the key in `secrets.yaml` doesn't match `API_KEYS_YAML`.

**Rotating the key:** `just api-key home-assistant`, replace its line in `API_KEYS_YAML`, `just secrets-push <env>`, `just restart <env>`, then update `secrets.yaml` and reload REST commands. The button fails with `401` between the restart and the reload, so do it outside opening hours.

### Planned automations

Written once the hardware exists. Both go in Home Assistant, not here.

- **Siren:** when `input_boolean.pixel_phone_ringing` turns on, sound the siren if Home Assistant's own rules allow (quiet hours, space closed); when it turns off, silence it. Purpose-specific triggers, `mode: restart`. Never on the `_dev` helper.
- **Button:** on the button's `event.*` entity (`event.received`), or its Zigbee2MQTT device trigger, call `rest_command.pixel_phone_accept` with `response_variable`, and turn the helper off **only if** the status is `202`. On anything else, leave the helper alone: if the accept failed, the call is still ringing and the siren should keep going. pixel-phone turns the helper off itself once the call leaves `ringing`. `mode: single`, so a double press sends one accept. A press with nothing ringing gets `404` and does nothing else.

## When the doorbell doesn't ring

Work from the outside in. Nothing here ever answers a call by itself: doing nothing lets the call ring out and OpenR try its next number.

| Symptom | Look at | Likely cause and fix |
| --- | --- | --- |
| No `telnyx.webhook` lines at all | `curl https://<url>/healthz`; Telnyx portal → the app → webhook URL; `just telnyx-sync <env> --check` | App down (roll back, see [Deploying](#deploying)), or the webhook URL drifted (`just telnyx-sync <env>`) |
| `telnyx.webhook_rejected` with `bad_signature` | Key Vault `telnyx-public-key` | Public key wrong: copy it from the portal, `just secrets-push`, `just restart` |
| `call.busy` for every call | `Calls` table: is a call stuck `ringing`/`accepting`? | Stuck calls retire on their own (15 s / 3 min). If not, `just restart <env>` recovers them |
| `call.ringing` but no siren | `home-assistant.failed` lines | Token or helper (see [Home Assistant](#home-assistant)). If HA flipped the helper, it's HA's automation |
| `call.ringing` but nothing in Discord | `queue.failed` lines; Pixel's logs | Queue unreachable, or Pixel isn't polling |
| Accept answers 202 but the phone isn't picked up | `telnyx.failed` with `during: answer` | Telnyx API key wrong or expired; the call rings out. Fix the key, push, restart |
| Picked up but silent, then hangs up | `media.failed` | Recording missing (`just media list`) or the app can't sign URLs (Storage Blob Delegator) |
| `call.missed` with `caller_hung_up` straight away | The caller hung up, or OpenR's ring time is short | See OpenR's ring time under [Calls](#calls) |


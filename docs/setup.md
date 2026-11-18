# Setting up from nothing

Everything needed to go from an empty Azure subscription to a doorbell answered in prod, in order. Each part ends with a check. Once it's done, day-to-day work is in the [runbook](runbook.md).

Each step is safe on its own: until Telnyx points a number at an environment, no doorbell call reaches it, and a call that reaches a half-set-up environment rings out to OpenR's next number ([ADR 0002](adr/0002-answer-only-on-accept.md)).

## 0. What you need

**Access.**

| Where | What | Needed for |
| --- | --- | --- |
| Azure, Pixelbar subscription `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4` | **Owner** | [Part 2](#_2-the-bootstrap) only. Later parts need only what the bootstrap and the env stacks grant |
| Azure, storage account `pixelbartfstate` | a Storage Blob Data role (shared keys are off) | Terraform state |
| GitHub, `pixelbar/pixel-phone` | admin | Environments, Pages, package visibility, secrets |
| Telnyx | an account user who can make API keys and order numbers | Calls |
| Sentry, org `ninjalikescheez`, project `pixel-phone` | a member, and an auth token for releases | Error reports (optional) |
| Home Assistant | an administrator | Ringing the space |
| DNS for `pixelbar.nl` | someone who can add records | `phone.pixelbar.nl` |
| Pixel | a maintainer | Answering from Discord |

**A laptop with:** Node 24 and pnpm, [just](https://just.systems), Docker, Terraform 1.11 or later, the Azure CLI (`az`), the GitHub CLI (`gh`) and `jq`.

## 1. The code runs

```sh
git clone https://github.com/pixelbar/pixel-phone && cd pixel-phone
just install
just azurite
just check                              # lint, types, tests
just simulate-call --accept-after 3     # a whole call against fakes
```

**Check:** `just check` passes and the simulated call ends `ended`.

## 2. The bootstrap

Resource groups, Terraform state and GitHub's Azure identities. Follow [`infra/bootstrap/README.md`](https://github.com/pixelbar/pixel-phone/blob/main/infra/bootstrap/README.md) as a subscription Owner:

1. `az login`, `az account set --subscription d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`.
2. Create the bootstrap's own state container once: `az storage container create --account-name pixelbartfstate --name pixel-phone-bootstrap --auth-mode login`.
3. `just tf-bootstrap plan`, then `just tf-bootstrap apply`. Keep the outputs.
4. In GitHub **Settings → Environments**, create `dev` and `prod`, each with the **variables** `ARM_CLIENT_ID` (that environment's `github_client_ids` output), `ARM_TENANT_ID` and `ARM_SUBSCRIPTION_ID`. On `prod`, add a **required reviewer** and limit deployments to `main`.

**Check:** `az group list --query "[?starts_with(name,'pixel-phone-')].name" -o tsv` lists `pixel-phone-bootstrap`, `pixel-phone-dev` and `pixel-phone-prod`.

## 3. The repository

| Setting | How | Why |
| --- | --- | --- |
| The image is public | After the first merge to `main` publishes it: **Packages → pixel-phone → Package settings → Change visibility → Public** | Azure pulls without credentials. The image holds no secrets |
| Sentry releases | Repository variables `SENTRY_ORG`, `SENTRY_PROJECT`; secret `SENTRY_AUTH_TOKEN` | Source maps for CD and releases. Without them, both skip with a warning |
| GitHub Pages | `gh api -X POST repos/pixelbar/pixel-phone/pages -f build_type=workflow` | The docs site, published by each release |
| `skip-changelog` label | **Issues → Labels → New label** | Pure chores skip the changelog check |
| Changelog bot (optional) | A GitHub App, as the header of `.github/workflows/changelog-merge.yml` describes | Resolves `CHANGELOG.md` conflicts in open PRs, and CI runs on its merges |

**Check:** an anonymous pull works: `docker pull ghcr.io/pixelbar/pixel-phone:main`.

## 4. dev

dev has its own Telnyx number and never touches the real siren: it flips `input_boolean.pixel_phone_ringing_dev`, which nothing is attached to.

1. **Maintainers.** Add your Entra ID object ID (`az ad user show --id <you>@pixelbar.nl --query id -o tsv`) to `maintainer_principal_ids` in `infra/envs/dev/terraform.example.tfvars`. It gives you the Key Vault and recordings roles.
2. **The stack.** `just tf-plan dev`, then `just tf-apply dev`. Every feature is off.
3. **The app.** `just deploy dev` (or **Actions → Deploy dev**). Check: `curl https://<dev fqdn>/version` shows the commit.
4. **Secrets.** Copy `.env.example` to `.env.dev`, set `PIXEL_PHONE_ENV=dev`, and fill in:
   - `TELNYX_API_KEY`: Telnyx portal → **Keys & Credentials → API Keys → Create**, a key only for dev.
   - `TELNYX_PUBLIC_KEY`: **Keys & Credentials → Public Key** (the account's, base64).
   - `SENTRY_DSN`: Sentry → `pixel-phone` → **Client Keys (DSN)**.
   - `API_KEYS_YAML`: `just api-key home-assistant` and `just api-key pixel`, both lines.

   Then `just secrets-push dev`.
5. **Features.** In `infra/envs/dev/terraform.example.tfvars`: `telnyx_enabled`, `accept_api_enabled` and `sentry_enabled = true`. `just tf-apply dev`.
6. **The recording.** `just media push dev media/placeholder-accepted.wav --name accepted.wav` (and `recording_accepted = "accepted.wav"` in the tfvars).
7. **A number.** Telnyx asks for a working webhook URL when you order a number, so order it now. Add it to `config/telnyx.dev.yaml`, then `just telnyx-sync dev`. Check: `just telnyx-sync dev --check`.
8. **Home Assistant.** [Connecting an environment](home-assistant.md#connecting-an-environment) for dev: the `_dev` helper, the `pixel-phone` user's dev token (`HOME_ASSISTANT_TOKEN`, pushed), `home_assistant_url` in the tfvars, then apply. Then [the button's](home-assistant.md#the-button) `rest_command.pixel_phone_accept_dev` with the `home-assistant` key.
9. **Pixel dev.** Give Pixel dev the `queue_url` output (`terraform -chdir=infra/envs/dev output queue_url`) as `PIXEL_PHONE_QUEUE_URL`, and the `pixel` key. Pixel dev's identity is already in `pixel_principal_id`.

**Check:** [Testing a real call on dev](runbook.md#testing-a-real-call-on-dev): a missed call, an accepted call, a busy call. The `_dev` helper flips and Discord shows the call.

## 5. prod

The same, with `prod`, new values for every secret, and `phone.pixelbar.nl`. Never copy a dev value: `just secrets-push prod` refuses a file that says `PIXEL_PHONE_ENV=dev`, but not a dev key pasted into `.env.prod`.

| | How | Check |
| --- | --- | --- |
| 1. Maintainers | Your object ID in `maintainer_principal_ids` in `infra/envs/prod/terraform.example.tfvars` | |
| 2. The stack | `just tf-plan prod`, then `PIXEL_PHONE_APPLY_PROD=1 just tf-apply prod`. Every feature is off; the app runs `:main` | `curl https://<fqdn output>/healthz` answers 200 |
| 3. `phone.pixelbar.nl` | Make the `CNAME` and `asuid` `TXT` records from the outputs, wait for them, set `custom_domains = ["phone.pixelbar.nl"]` and apply again ([`infra/envs/prod/README.md`](https://github.com/pixelbar/pixel-phone/blob/main/infra/envs/prod/README.md)) | `curl https://phone.pixelbar.nl/healthz` answers 200, certificate valid |
| 4. Secrets | `.env.prod` with `PIXEL_PHONE_ENV=prod` and **new** values: a prod Telnyx API key, the account's public key, a `pixel-phone prod` Home Assistant token, new `just api-key home-assistant` and `just api-key pixel` keys, the Sentry DSN. `just secrets-push prod` | `az keyvault secret list --vault-name pixel-phone-prod-kv --query "[].name" -o tsv` lists them |
| 5. Features | In `infra/envs/prod/terraform.example.tfvars`: `telnyx_enabled`, `accept_api_enabled`, `sentry_enabled = true`, `home_assistant_url`. Plan, then apply | `az containerapp show -g pixel-phone-prod -n pixel-phone-prod --query "properties.template.containers[0].env[].name"` lists them |
| 6. The recording | `just media push prod <file> --name accepted.mp3`: the real one, not the dev placeholder | `just media list prod`; no `media.failed` at startup |
| 7. The first release | `just release`, then approve **prod** in the run ([Releasing](runbook.md#releasing)) | `curl https://phone.pixelbar.nl/version` shows the release's SHA |
| 8. Telnyx | `just telnyx-sync prod` makes the `pixel-phone-prod` application with webhooks to `phone.pixelbar.nl`. Optionally set `failover_host` in `config/telnyx.prod.yaml` to the `fqdn` output, so calls still arrive if `phone.pixelbar.nl`'s DNS breaks | `just telnyx-sync prod --check` |
| 9. Home Assistant | `rest_command.pixel_phone_accept` to `https://phone.pixelbar.nl`, with prod's `home-assistant` key as `pixel_phone_accept_authorization` ([The button](home-assistant.md#the-button)). The siren automation watches `input_boolean.pixel_phone_ringing` | Running the action with nothing ringing answers `404` |
| 10. Pixel prod | `PIXEL_PHONE_QUEUE_URL` = the `queue_url` output, and prod's `pixel` key. Pixel prod's identity is already in `pixel_principal_id` | |
| 11. The number | Order the prod number (#21), add it to `config/telnyx.prod.yaml`, `just telnyx-sync prod`. Then put it on OpenR's list | A doorbell press rings the space, shows in Discord, and an accept plays the recording |

## Afterwards

- **Releasing, rolling back, rotating secrets** and **when the doorbell doesn't ring:** the [runbook](runbook.md).
- **Changing infrastructure:** edit `infra/`, `just tf-plan <env>`, then apply from a laptop. CI validates every stack and plans dev; it never applies.
- **Tearing dev down:** `terraform -chdir=infra/envs/dev destroy -var-file=terraform.example.tfvars` (after `just tf-plan dev` has initialised it). Its Key Vault is purged; prod's has purge protection and can't be.

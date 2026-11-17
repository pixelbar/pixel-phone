# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, releases stay on 0.x: `Added` bumps minor, `Fixed`/`Changed` (and the other Keep a Changelog types) bump patch. The major version is never bumped automatically.

## [Unreleased]

### Added

- The repository, laid out like Pixel's: TypeScript on Node 24, pnpm, Biome, vitest, `just`, and CI that runs `just check`, a Docker build and the changelog check on every pull request (#1).
- Terraform bootstrap (`just tf-bootstrap`): the `pixel-phone-dev` and `pixel-phone-prod` resource groups, their state containers in the shared `pixelbartfstate` account, and a GitHub Actions identity per environment that logs in with OIDC, with no client secret (#3).
- The dev environment (`just tf-plan dev`, `just tf-apply dev`): a Container App that scales from zero to one replica with a public HTTPS hostname, a Key Vault, and a storage account (shared keys off) with the `Calls` and `WebhookEvents` tables, the `phone-events` queue Pixel reads, and the `media` container for recordings. CI validates the Terraform and plans dev on pull requests (#4).
- `infra/secrets.manifest.yaml` lists every Key Vault secret (Telnyx key and public key, Home Assistant token, the accept API's keys, Sentry DSN). `just secrets-push <env>` and `just secrets-pull <env>` sync them with `.env.<env>`, showing which change but never a value, and `just restart <env>` makes the app read them again. Each secret's feature is off in Terraform until its secrets exist (#5).
- The HTTP service: `GET /healthz`, `GET /version`, and a `POST /webhooks/telnyx` stub that logs each event's type and returns 200, so the webhook URL can be given to Telnyx. Config is validated at startup, logs are JSON with secrets redacted, and errors go to Sentry when `SENTRY_DSN` is set. Merges to `main` publish the image to GHCR, and **Deploy dev** (or `just deploy dev`) puts a branch on `pixel-phone-dev` (#6).
- `just telnyx-sync <env>` makes the Telnyx Call Control application and the environment's numbers match `config/telnyx.<env>.yaml`: webhook URL, API version 2, first command timeout off, two inbound lines. It shows a diff and asks first; `--check` fails on drift made in the portal (#8).
- Telnyx webhooks are verified (Ed25519 signature over the raw body, five-minute replay window) and de-duplicated by event ID in the `WebhookEvents` table. Bad signatures get 401 and a warning; verified call events are acknowledged at once and handed to the call flow (#9).
- `just azurite` runs local Azure Storage in Docker for tests and `just dev`; CI starts it too (#9).
- A Telnyx Call Control client behind a `Telephony` port: answer, play and hang up, each with a `command_id`, a five-second limit and one retry on a network error only. A call that has already ended comes back as `CallGone` (#10).
- The call state machine and its store (the `Calls` table): a call rings until someone accepts, the 15-second window ends (`ACCEPT_WINDOW_SECONDS`) or the caller hangs up; a second call while one is active is busy. The first accept wins, with conditional writes so two at once can't both win. Calls left ringing by a restart are marked missed on startup (#11).
- A Home Assistant ringer: turns the ringing helper on and off through HA's API, with a three-second limit and no retry. Without Home Assistant configured it only logs (#12).
- Call events for Pixel, contract v1 (`docs/events.md`, JSON Schema from `just events-schema`): `ringing`, `accepted`, `missed`, `busy` and `ended`, sent as plain JSON to the `phone-events` queue with a five-minute TTL and a three-second limit (#13).
- Maintainers can read the `Calls` table and peek at `phone-events` for debugging (#13).
- The accept API for Home Assistant and Pixel: `POST /api/v1/calls/current/accept` and `POST /api/v1/calls/{callId}/accept`, with a bearer key per caller from `API_KEYS_YAML` (compared in constant time, never logged), ten requests a minute per key, and `202`/`404`/`409`/`410` answers. `just api-key <id>` makes a key. Described in `docs/openapi.yaml` (#14).

### Changed

- pixel-phone now keeps one replica running at all times instead of scaling to zero. Starting from zero took about 25 seconds, longer than the 15 seconds anyone has to answer the doorbell (#29).

[Unreleased]: https://github.com/pixelbar/pixel-phone/commits/main

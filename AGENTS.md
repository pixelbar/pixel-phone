# AGENTS.md

Guidance for AI coding agents (and humans) working on pixel-phone, the service that answers the Pixelbar doorbell.

Read before making structural changes:

- [`README.md`](README.md): what pixel-phone does, and the call state diagram.
- [`docs/architecture.md`](docs/architecture.md): how the parts fit, and the configuration table.
- [`docs/adr/`](docs/adr/): why it is built this way. Don't reopen a decision there because an old issue says otherwise; write a new ADR that supersedes it.
- [`docs/runbook.md`](docs/runbook.md): deploying, secrets, and what to do when the doorbell doesn't ring.

The layout and tooling copy [pixelbar/pixel](https://github.com/pixelbar/pixel). When in doubt about a convention, do what Pixel does.

## The one rule about calls

**pixel-phone sends Telnyx no command until someone accepts.** OpenR's intercom calls a list of numbers and moves on only when a call goes _unanswered_. A call we answer and then hang up counts as handled, and nobody else is called. So:

- Don't answer to play a greeting, a "busy" message or a rejection.
- On a timeout, a failure, or anything unexpected, do nothing to the call. It rings out and OpenR tries the next number. Doing nothing is always the safe fallback.

## Commands

Always go through `just`:

```sh
just dev              # run locally with hot reload
just check            # lint + typecheck + tests with coverage thresholds; must pass before you call a change done
just test             # tests only
just fmt              # auto-format (Biome, and Terraform if `terraform` is on PATH)
just check-changelog  # fail if this branch does not change CHANGELOG.md vs origin/main
just changelog-merge  # in a stopped merge/rebase: keep both sides' CHANGELOG [Unreleased] entries when safe
just bump             # cut [Unreleased] into a dated version and bump package.json
```

If you need a new repeatable task, add a `just` recipe instead of documenting a raw command.

## Layout

```
src/
  index.ts          # entry point: config, adapters, HTTP server, shutdown
  config.ts         # zod-validated env; the ONLY place that reads process.env
  core/             # the call domain and its ports; imports nothing outside core (a test enforces it)
  adapters/<name>/  # one folder per platform: telnyx, home-assistant, queue, storage, media
  http/             # fastify app, routes, auth
  observability/    # logger, Sentry, secret scrubbing
  testing/          # fakes for tests; never imported by app code
tests/              # every *.test.ts, mirroring src/ (tests/core/x.test.ts tests src/core/x.ts)
scripts/            # laptop and CI tools (changelog, secrets, Telnyx sync)
infra/              # Terraform: bootstrap/, modules/pixel-phone, envs/dev, envs/prod
docs/               # architecture, runbook, ADRs
CHANGELOG.md        # Keep a Changelog 1.1.0; most PRs add an Unreleased entry
```

## Conventions

- **TypeScript on Node 24, ESM only.** Strict, no `any`. All user-facing text (recordings' scripts, Pixel messages, docs) is English.
- **Dependency direction:** `http → core ← adapters`. `core` imports nothing from other folders. A platform SDK (Telnyx, Azure, Home Assistant's API) is used only in its adapter. When the core needs something from a platform, it defines a port and the adapter implements it.
- **Fail closed and fail quiet.** Every outbound call has a time limit. No retries on anything that changes a call, except Telnyx commands sent with a `command_id`, which Telnyx de-duplicates.
- **Logging:** pino is the only logger. No `console.log`. Never log secrets, tokens, API keys or signature headers. Phone numbers may be logged: nearly every call comes from the doorbell (ADR on observability).
- **Tests** use fakes from `src/testing/` and never call live Telnyx, Home Assistant or Azure. Storage adapters are tested against Azurite.
- **Changelog:** every PR with user or operator impact adds a line under `## [Unreleased]`. Pure chores use the `skip-changelog` label.

## Security

- Webhooks from Telnyx are accepted only with a valid Ed25519 signature over the raw body, within the replay window.
- The accept API answers a call, so it needs a bearer API key, compared in constant time. Changes to `src/http/auth*`, the webhook signature check, or the accept route need tests and a human reviewer. Call that out in the PR description.
- Secrets live in Key Vault, listed in `infra/secrets.manifest.yaml`. Never put a secret in the image, in Terraform state, in a test fixture that looks real, or in a log.
- `dev` never touches the real siren: it flips `input_boolean.pixel_phone_ringing_dev`, which nothing is attached to.

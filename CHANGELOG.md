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

[Unreleased]: https://github.com/pixelbar/pixel-phone/commits/main

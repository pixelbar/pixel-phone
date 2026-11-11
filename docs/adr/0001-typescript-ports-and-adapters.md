# 0001. TypeScript, ports and adapters, fastify

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

pixel-phone is a small Pixelbar service, maintained by the same people as [Pixel](https://github.com/pixelbar/pixel) and [spacestate](https://github.com/pixelbar/spacestate). Pixel is a gateway bot with no HTTP surface to speak of; spacestate is a public HTTP API. pixel-phone is a webhook receiver with a small API, which talks to Telnyx, Home Assistant and Azure Storage.

## Decision

- **Pixel's shape.** TypeScript on Node 24, ESM, strict, no `any`. pnpm, Biome, vitest, `just`, Keep a Changelog, ADRs, `AGENTS.md`. Terraform as `infra/bootstrap`, `infra/modules/pixel-phone` and `infra/envs/<env>`, with Key Vault and a secrets manifest.
- **spacestate's HTTP.** fastify for the webhook receiver and the accept API, with zod for every input.
- **Ports and adapters.** `src/core` holds the call domain and its ports and imports nothing outside core. `src/adapters/<platform>` implements the ports; a platform SDK is imported only in its adapter. `src/http` turns requests into core calls. A test enforces the direction.

## Consequences

- Anyone who has worked on Pixel finds the same commands, layout and release flow here.
- The call flow is tested against fakes of every port, with a fake clock, and never against live Telnyx or Home Assistant.

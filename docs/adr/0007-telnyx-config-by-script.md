# 0007. Telnyx config by a script, not Terraform

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

The Telnyx side is a Call Control application (webhook URLs, timeouts) and the numbers pointed at it. Telnyx has no official Terraform provider. The community providers have zero to two stars and one or two maintainers, and would hold an API key that can buy numbers and place calls.

## Decision

- **`just telnyx-sync <env>`** (`scripts/telnyx-sync.ts`) makes the application and number assignments match what the repository says. It is idempotent, shows a diff and asks before writing, and has `--check` to fail on drift.
- Numbers per environment are listed in committed files (`config/telnyx.<env>.yaml`). Numbers are not secret.
- The API key comes from the local `.env.<env>` or Key Vault and is never printed.

## Consequences

- A portal change is caught by `--check`, not silently overwritten.
- Moving to a provider later is possible if an official one appears.

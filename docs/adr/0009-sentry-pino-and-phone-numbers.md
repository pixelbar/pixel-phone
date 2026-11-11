# 0009. Sentry and pino; phone numbers aren't treated as private

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

Pixel reports errors to Sentry and logs with pino, keeping personal data out ([Pixel ADR 0005](https://github.com/pixelbar/pixel/blob/main/docs/adr/0005-sentry-and-pino.md)). pixel-phone's calls carry phone numbers. Nearly every call comes from one number: the doorbell's own line.

## Decision

- **Sentry** for unexpected errors, loaded before the app. No DSN means Sentry does nothing.
- **pino** is the only logger: stdout and Sentry Logs. No `console.log`.
- **Phone numbers (`from`, `to`) may be logged and sent to Sentry.** They identify the doorbell, not a person, in almost every case.
- **Secrets are still redacted:** API keys, tokens, `authorization` headers, Telnyx signature headers and SAS signatures never reach a log or Sentry.
- Every call outcome writes one log line, `call.<outcome>`, with `callId`, `from`, `to` and who accepted.

## Consequences

- A call can be followed end to end in the logs by `callId` and number.
- If a person's own number ever calls pixel-phone directly, it is logged too. That's accepted.

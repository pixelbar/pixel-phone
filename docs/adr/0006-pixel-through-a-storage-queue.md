# 0006. Pixel through an Azure Storage Queue

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

Pixel posts the doorbell in Discord with an Answer button, and brokers answering from there. Pixel has no ingress ([Pixel ADR 0004](https://github.com/pixelbar/pixel/blob/main/docs/adr/0004-azure-container-apps.md)), so pixel-phone can't call it.

## Decision

- **pixel-phone writes call events to an Azure Storage Queue it owns,** `phone-events`, with its managed identity. Pixel polls the queue about once a second with its own managed identity, which pixel-phone's Terraform grants Storage Queue Data Message Processor on that queue only.
- **The contract is versioned JSON** (`version: 1`): `ringing` (with `acceptBy`), `accepted` (with `via` and `by`), `missed` (with `reason`), `busy` and `ended`, each with `callId`, `occurredAt`, `from` and `to`. Messages expire after 5 minutes. Order isn't guaranteed.
- **Pixel accepts through pixel-phone's accept API,** like Home Assistant, with its own API key, passing who clicked (`by: discord:<id>`) for the record. Pixel checks its own `doorbell` capability before calling.
- **If Home Assistant and the queue both fail** when a call starts ringing, nothing more is done. Nobody can accept, the call rings out, and OpenR moves on.

## Consequences

- Neither side needs new ingress. The only cross-repo infrastructure is one role assignment, kept here.
- Polling once a second costs a few cents a month.

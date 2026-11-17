# Call events for Pixel (contract v1)

pixel-phone tells Pixel about doorbell calls through the Azure Storage Queue `phone-events` in its storage account ([ADR 0006](adr/0006-pixel-through-a-storage-queue.md)). Pixel reads and deletes messages with its own managed identity (Storage Queue Data Message Processor on that queue only).

The contract lives in [`src/core/events.ts`](../src/core/events.ts). `just events-schema` writes it as JSON Schema to [`events.schema.json`](events.schema.json); a test fails if that file is stale.

## Messages

- Each message is **one JSON object**, as plain text (not base64).
- Messages live **five minutes**. A stale `ringing` is useless, so the queue drops it.
- **There is no ordering.** Two events for the same call can arrive in either order. Key on `callId` and compare `occurredAt`; an `accepted`, `missed` or `ended` beats a `ringing`.
- Every message has `version: 1`. A breaking change publishes `version: 2` alongside until Pixel has moved. Ignore versions you don't know.
- `from` and `to` are E.164 numbers when Telnyx gave them. Nearly every call comes from the doorbell intercom.

| `type` | When | Extra fields |
| --- | --- | --- |
| `ringing` | A call arrived and nobody is on another one | `acceptBy`: accepts after this get `410` |
| `accepted` | Someone accepted; pixel-phone is answering and playing the recording | `via` (the API key: `home-assistant` or `pixel`), optional `by` |
| `missed` | Nobody accepted, or the caller hung up first. OpenR calls its next number | `reason`: `timeout` or `caller_hung_up` |
| `busy` | A call arrived while another was active. Not answered; OpenR moves on | `activeCallId` |
| `ended` | An accepted call finished | `reason`: `playback_finished`, `caller_hung_up` or `abandoned` |

### Examples

```json
{ "version": 1, "type": "ringing", "callId": "20261118-3f9a1c2b7d4e", "occurredAt": "2026-11-18T09:00:00.000Z", "from": "+31201234567", "to": "+31103024128", "acceptBy": "2026-11-18T09:00:15.000Z" }
```

```json
{ "version": 1, "type": "accepted", "callId": "20261118-3f9a1c2b7d4e", "occurredAt": "2026-11-18T09:00:06.120Z", "from": "+31201234567", "to": "+31103024128", "via": "pixel", "by": "discord:123456789012345678" }
```

```json
{ "version": 1, "type": "missed", "callId": "20261118-3f9a1c2b7d4e", "occurredAt": "2026-11-18T09:00:15.004Z", "from": "+31201234567", "to": "+31103024128", "reason": "timeout" }
```

```json
{ "version": 1, "type": "busy", "callId": "20261118-0a1b2c3d4e5f", "occurredAt": "2026-11-18T09:00:04.000Z", "from": "+31201234567", "to": "+31103024128", "activeCallId": "20261118-3f9a1c2b7d4e" }
```

```json
{ "version": 1, "type": "ended", "callId": "20261118-3f9a1c2b7d4e", "occurredAt": "2026-11-18T09:00:12.500Z", "from": "+31201234567", "to": "+31103024128", "reason": "playback_finished" }
```

## What Pixel does with them

1. On `ringing`, post the doorbell in Discord with an **Answer** button, if `acceptBy` hasn't passed.
2. On **Answer**, call the accept API (below) with the `callId`.
3. On `accepted`, `missed` or `ended`, update the post (who answered, or that nobody did) and remove the button.

## The accept API

Accepting makes pixel-phone answer the call and play the accept recording. The first accept wins, from either caller. [`openapi.yaml`](openapi.yaml) is the full description.

```http
POST /api/v1/calls/{callId}/accept      (Pixel, with the callId from `ringing`)
POST /api/v1/calls/current/accept       (Home Assistant's button: whatever is ringing now)
Authorization: Bearer <key>
Content-Type: application/json

{ "by": "discord:123456789012345678" }  (optional; recorded, not trusted)
```

| Status | Meaning | Body |
| --- | --- | --- |
| `202` | Accepted; pixel-phone is answering | `{ "callId" }` |
| `400` | The body isn't `{ "by"?: string }` | `{ "error" }` |
| `401` | Missing or wrong key | `{ "error" }` |
| `404` | Nothing is ringing, or no such call | `{ "error" }` |
| `409` | Someone accepted first | `{ "callId", "via", "by"? }` |
| `410` | Too late: the window passed or the call is over | `{ "callId" }` |
| `429` | More than 10 requests a minute with this key | `{ "error" }` |
| `503` | The accept API isn't configured | `{ "error" }` |

Each caller has its own key in `API_KEYS_YAML`. The key's `id` (`home-assistant`, `pixel`) is recorded as `via` and shows up in the `accepted` event. Pixel checks the `doorbell` capability before calling; pixel-phone trusts the key, not `by`.

# 0005. Home Assistant owns the siren

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

The siren and the button are in the space and will be Home Assistant devices, probably ESPHome. Which hardware, and whether the siren should sound at all right now (quiet hours, the space being closed), are decisions for Home Assistant, not for pixel-phone. Pixel reaches Home Assistant over its WebSocket API through the Nabu Casa URL ([Pixel ADR 0011](https://github.com/pixelbar/pixel/blob/main/docs/adr/0011-home-assistant.md)).

## Decision

- **pixel-phone only flips a helper:** `input_boolean.pixel_phone_ringing` goes on when a call starts ringing and off when it leaves `ringing`, however it leaves. Home Assistant's automations decide whether the siren sounds, and silence it.
- **Over the REST API** (`/api/services/input_boolean/turn_on|turn_off`), not WebSocket. pixel-phone is short-lived and scales to zero; a request per change is simpler than holding a socket.
- **Through the Nabu Casa URL** for now, with a long-lived token for a **non-admin** Home Assistant user.
- **The button reaches pixel-phone, not the other way round.** A Home Assistant automation calls pixel-phone's accept API with its own API key (ADR 0006 describes the API's other caller).
- **dev flips `input_boolean.pixel_phone_ringing_dev`,** which nothing is attached to. Config validation refuses the prod entity in dev.
- Every call has a 3-second time limit and no retries. A failure is reported and the call carries on: Pixel may still reach someone.

## Consequences

- Changing the siren hardware, or when it sounds, is a Home Assistant change only.
- The token can do whatever its Home Assistant user can, so that user gets as little as possible.

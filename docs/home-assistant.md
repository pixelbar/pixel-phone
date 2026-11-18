# Home Assistant

Home Assistant owns the siren ([ADR 0005](adr/0005-home-assistant-owns-the-siren.md)). pixel-phone only turns a helper on while a call rings and off when it stops ringing; Home Assistant's own automations decide whether the siren sounds, and may turn the helper off themselves.

| | dev | prod |
| --- | --- | --- |
| Helper | `input_boolean.pixel_phone_ringing_dev` "Pixel Phone ringing (dev)" (nothing is attached to it) | `input_boolean.pixel_phone_ringing` "Pixel Phone ringing" |
| URL | the Nabu Casa URL, `home_assistant_url` in `infra/envs/<env>/terraform.example.tfvars` | same |
| Accept action | `rest_command.pixel_phone_accept_dev` | `rest_command.pixel_phone_accept` (with prod, #20) |
| Accept key in HA | `pixel_phone_dev_accept_authorization` in `secrets.yaml` | `pixel_phone_accept_authorization` |
| HA user | `pixel-phone`, not an administrator, one token per environment | same user |

Config refuses a non-`_dev` helper outside prod, and Terraform pins dev's helper.

**What is set up in Pixelbar's Home Assistant** (2026.9; #18, 2026-11-18):

| Item | State |
| --- | --- |
| Both helpers | Created on 2026-11-18. Nothing uses them yet |
| `pixel-phone` user and its tokens | Made by hand (step 2 below) |
| `rest_command.pixel_phone_accept_dev` | Made by hand (see [The button](#the-button)) |
| Siren automation | **Not yet:** Home Assistant has no siren. The WLED "Siren Party Light" (`light.wled`) is only a light |
| Button automation | **Not yet:** Home Assistant has no accept button |

## Connecting an environment

1. The helper exists (see the table above). If it is ever missing: **Settings → Devices & services → Helpers → Create helper → Toggle**, named `Pixel Phone ringing (dev)` (its ID becomes `input_boolean.pixel_phone_ringing_dev`).
2. **Settings → People → Users → Add user** `pixel-phone`, **not** an administrator, "Can only log in from the local network" off. Log in as it once in a private window, then **Profile → Security → Long-lived access tokens → Create token**, named after the environment (`pixel-phone dev`).
3. Put the token in `.env.dev` as `HOME_ASSISTANT_TOKEN`, then `just secrets-push dev`.
4. Set `home_assistant_url` in `infra/envs/dev/terraform.example.tfvars` and `just tf-apply dev`.
5. Check: `curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"entity_id":"input_boolean.pixel_phone_ringing_dev"}' https://<nabu casa url>/api/services/input_boolean/turn_on` flips the helper on. Turn it off the same way.

Each call has three seconds and no retry. A failure is logged as `home-assistant.failed` and sent to Sentry with the tag `area: home-assistant`; the call still reaches Pixel through the queue.

Without `home_assistant_url`, pixel-phone logs `ringer.off` instead of ringing.

| `home-assistant.failed` says | Fix |
| --- | --- |
| `401 (is HOME_ASSISTANT_TOKEN valid?)` | The token was revoked or mistyped: make a new one (step 2), push, restart |
| `400` / `404 (does input_boolean… exist…)` | The helper is missing or renamed (step 1) |
| `didn't get through (TimeoutError)` | Home Assistant or Nabu Casa is down or slow |

**What the token can do.** Home Assistant can't limit a token to some actions or entities: a non-admin user can still call any action on any entity, but can't change configuration, users or integrations. Not being an administrator is all the narrowing Home Assistant offers ([ADR 0005](adr/0005-home-assistant-owns-the-siren.md)). So the token is a Key Vault secret like the others, and only pixel-phone has it.

**Rotating the token:** log in as `pixel-phone`, create a new token, put it in `.env.<env>`, `just secrets-push <env>`, `just restart <env>`, check with step 5, then delete the old token on the same page. Do this too if someone leaves who had the user's password.

## The button

The button reaches pixel-phone through the accept API with the `home-assistant` key ([Giving a caller a key](runbook.md#giving-a-caller-a-key)). The key is kept in Home Assistant's `secrets.yaml`, never in an automation.

`rest_command` exists only in YAML. With the **File editor** app, copy `configuration.yaml` and `secrets.yaml` first, then add to `secrets.yaml`:

```yaml
pixel_phone_dev_accept_authorization: "Bearer <the home-assistant key for dev>"
```

and to `configuration.yaml`:

```yaml
rest_command:
  pixel_phone_accept_dev:
    url: https://pixel-phone-dev.ashysky-f402cc54.westeurope.azurecontainerapps.io/api/v1/calls/current/accept
    method: post
    headers:
      authorization: !secret pixel_phone_dev_accept_authorization
    content_type: application/json
    payload: '{"by":"button"}'
    timeout: 5
```

Then **Tools → YAML → Check configuration**, and reload **REST commands** (restart Home Assistant if it isn't listed). Prod gets `pixel_phone_accept`, with its own key and URL, when prod exists.

**Trying it:** in **Tools → Actions**, run `rest_command.pixel_phone_accept_dev` with **Return response** on. With nothing ringing, the response has `status: 404`; while a real call to the dev number rings, `status: 202` and the phone picks up. A `401` means the key in `secrets.yaml` doesn't match `API_KEYS_YAML`.

**Rotating the key:** `just api-key home-assistant`, replace its line in `API_KEYS_YAML`, `just secrets-push <env>`, `just restart <env>`, then update `secrets.yaml` and reload REST commands. The button fails with `401` between the restart and the reload, so do it outside opening hours.

## Planned automations

Written once the hardware exists. Both go in Home Assistant, not here.

- **Siren:** when `input_boolean.pixel_phone_ringing` turns on, sound the siren if Home Assistant's own rules allow (quiet hours, space closed); when it turns off, silence it. Purpose-specific triggers, `mode: restart`. Never on the `_dev` helper.
- **Button:** on the button's `event.*` entity (`event.received`), or its Zigbee2MQTT device trigger, call `rest_command.pixel_phone_accept` with `response_variable`, and turn the helper off **only if** the status is `202`. On anything else, leave the helper alone: if the accept failed, the call is still ringing and the siren should keep going. pixel-phone turns the helper off itself once the call leaves `ringing`. `mode: single`, so a double press sends one accept. A press with nothing ringing gets `404` and does nothing else.

# 0003. Azure Container Apps, one always-warm replica, public ingress, two environments

* Status: accepted (the replica count is amended by #29, below)
* Date: 2026-11-11
* Issue: #2

## Context

Telnyx needs a public HTTPS webhook URL, and applying for a number needs one to exist. Calls are rare: a few a day. Pixel runs on Azure Container Apps without ingress, and spacestate runs there with public ingress and scale to zero.

## Decision

- **Azure Container Apps,** West Europe, in the Pixelbar subscription, with **public ingress** on port 3000.
- **`min_replicas = 0`, `max_replicas = 1`.** A replica wakes on Telnyx's first webhook. That's fine while the cold start is a few seconds, because we don't answer straight away anyway: a cold start only delays the siren. #6 measures it, and if it is much more than about 5 seconds we revisit `min_replicas`.
- **Two environments, `dev` and `prod`,** each in its own resource group, with its own Key Vault, storage account and Telnyx application. dev uses its `*.azurecontainerapps.io` hostname. prod uses `phone.pixelbar.nl`.
- **Images on GHCR** (`ghcr.io/pixelbar/pixel-phone:<sha>`), public, holding no secrets. After the first create, Terraform doesn't own the running image: deploys swap it with `az containerapp update`, as in Pixel ADR 0010.

## Consequences

- The accept window timer runs in the process. Container Apps only scales to zero after minutes without requests, so a replica outlives every call it handles.
- dev never touches the real siren (ADR 0005).

## Amendment: one always-warm replica (2026-11-17, #29)

#6 measured the cold start on dev: **24.9 s** from zero replicas to the first response, against 0.04 s warm. That is longer than the 15 s accept window (ADR 0004), so a doorbell call that woke a sleeping replica would ring out before the siren started. Most calls arrive after an idle spell, so most would be missed.

- **`min_replicas = 1`, `max_replicas = 1`, in both environments.** Like Pixel's, the replica count is fixed in the module, not a variable.
- It costs one idle 0.25 vCPU / 0.5 GiB replica per environment, billed at Container Apps' idle rate, partly inside the monthly free grant: a few euros a month.
- Rejected: a smaller image with a faster startup (probably still well over 5 s, paid on every call after an idle spell), and a scheduled ping to keep a replica warm (the same cost, with more moving parts).
- Consequence: a deploy still replaces the replica, so there are a few seconds during a roll when a call can be missed. Deploy outside opening hours.

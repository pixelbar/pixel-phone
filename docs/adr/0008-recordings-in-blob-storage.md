# 0008. Recordings in our own Blob container

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

Telnyx plays audio from a URL (WAV or MP3), or from files uploaded to its own media storage. We want to keep the recordings in storage we control, and change them without a deploy.

## Decision

- **Recordings live in a private Blob container,** `media`, in the environment's storage account. `just media push <env> <file>` uploads one.
- **Telnyx gets a short-lived, read-only, user-delegation SAS URL** for each playback, signed by the app's managed identity. There are no public blobs and no account keys (shared keys are off on the account).
- The app identity can read `media` but not write it.

## Consequences

- Changing a recording is an upload, not a deploy.
- A leaked playback URL stops working within minutes.

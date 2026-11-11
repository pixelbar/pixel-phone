# 0004. Call state in Table storage, one call at a time, first accept wins

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

Between a call arriving and someone accepting it, pixel-phone has to remember the call: its Telnyx `call_control_id`, when the accept window ends, and whether it has been accepted. Two people can accept at once: one at the button in the space, one in Discord. The app scales to zero and can restart.

## Decision

- **Calls are rows in an Azure Table** (`Calls`), partitioned by day, keyed by our own `callId`. Rows are kept for 90 days, which is also the call history.
- **One active call at a time.** A call that arrives while another is ringing or being answered is recorded as `busy` and gets no command, so it rings out.
- **The first accept wins, wherever it comes from.** Accepting is an ETag-conditional update from `ringing` to `accepting`; the loser gets "already accepted" with who won.
- **The accept window is 15 seconds by default** (`ACCEPT_WINDOW_SECONDS`), from when the call arrives. After it, accepts are refused as too late and the call is left to ring out.
- **On startup,** calls still `ringing` past their window are marked `missed`, with the same side effects as a timeout.
- Telnyx webhook IDs are de-duplicated in a second table, `WebhookEvents`, because Telnyx can deliver an event more than once.

## Consequences

- A restart mid-call loses nothing that matters: the row survives, and a late accept is refused cleanly.
- No database server. Table storage costs pennies at this volume.

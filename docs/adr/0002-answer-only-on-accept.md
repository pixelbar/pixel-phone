# 0002. Telnyx Call Control, and we answer only on accept

* Status: accepted
* Date: 2026-11-11
* Issue: #2

## Context

When someone presses the doorbell at the building, OpenR's intercom calls a list of numbers in turn. One of them is a Telnyx number that rings pixel-phone. OpenR moves to the next number **only when a call goes unanswered**. A call that is answered and then hung up counts as handled, and nobody else is called.

The first design answered at once, played a greeting on a loop while someone walked to the button, and played a rejection message after a timeout. That would end OpenR's list on every unanswered doorbell.

Telnyx offers two ways to run a call. TeXML is a document fetched when the call arrives, describing the whole call up front. Call Control is a stream of webhooks, with commands sent back over the REST API at any time.

## Decision

- **Call Control, not TeXML.** The accept comes from outside the call (a button in the space, or Discord), seconds after it arrives, which is what Call Control's commands are for.
- **pixel-phone sends Telnyx no command until someone accepts.** Until then the visitor hears ringing.
- **On accept:** answer, play the accept recording ("someone is on their way to let you in"), and hang up when it has played.
- **On anything else** (the accept window passes, the caller hangs up, a dependency fails, a bug) **do nothing to the call.** It rings out, and OpenR tries the next number. Doing nothing is the safe fallback everywhere.
- **The Telnyx application has `first_command_timeout` off,** so Telnyx doesn't drop a call that is waiting for an accept.
- There is no greeting, busy message or rejection recording: none can be played without answering.

## Consequences

- One recording, `accepted`.
- A second doorbell call while one is active is not answered either. It rings out, and OpenR moves on (ADR 0004).
- OpenR's own ring time for each number may be shorter than our accept window. The runbook records it, because it bounds how long someone has to reach the button.

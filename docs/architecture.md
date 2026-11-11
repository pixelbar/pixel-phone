# Architecture

pixel-phone answers the Pixelbar doorbell. See the [README](../README.md) for the call state diagram.

## Parts

| Part           | Role                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenR intercom | Calls a list of numbers when the doorbell is pressed, and moves on only when a call goes unanswered                            |
| Telnyx         | Owns the number and sends call events to pixel-phone's webhook (Call Control)                                                  |
| pixel-phone    | Tracks the call, flips the Home Assistant switch, tells Pixel, and answers when someone accepts                                |
| Home Assistant | Owns the siren and the button. Turns the siren on and off from the switch, and calls the accept API when the button is pressed |
| Pixel          | Reads call events from a queue, posts the doorbell in Discord with an Answer button, and calls the accept API                  |

The design decisions are recorded in [`adr/`](adr/).

## Configuration

Every setting is read in `src/config.ts`. This table grows as features land.

| Variable | Required | Description |
| -------- | -------- | ----------- |

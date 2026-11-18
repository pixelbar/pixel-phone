/**
 * Call events for Pixel, contract v1 (ADR 0006, docs/events.md). Pixel reads them from the
 * `phone-events` Storage Queue. This file is the contract: `just events-schema` turns it
 * into docs/events.schema.json for Pixel.
 *
 * Changing a field's meaning or removing one is a breaking change: add `version: 2`
 * instead, and publish both until Pixel has moved.
 */
import { z } from "zod";
import type { Call } from "./calls.ts";

const e164ish = z.string().min(1).max(32);
const callId = z.string().regex(/^\d{8}-[0-9a-f]{12}$/);
const isoTime = z.iso.datetime({ offset: true });

const base = {
	version: z.literal(1),
	callId,
	/** When it happened. Messages aren't ordered: sort by this. */
	occurredAt: isoTime,
	/** The caller's number, when Telnyx gave it. */
	from: e164ish.optional(),
	/** The number that was called. */
	to: e164ish.optional(),
};

export const ringingEvent = z.strictObject({
	...base,
	type: z.literal("ringing"),
	/** Accepts after this are refused (410). */
	acceptBy: isoTime,
});

export const acceptedEvent = z.strictObject({
	...base,
	type: z.literal("accepted"),
	/** The API key that accepted: `home-assistant` (the button) or `pixel`. */
	via: z.string().min(1),
	/** Who, if the caller said (e.g. `discord:1234`). Not verified. */
	by: z.string().min(1).optional(),
});

export const missedEvent = z.strictObject({
	...base,
	type: z.literal("missed"),
	reason: z.enum(["timeout", "caller_hung_up"]),
});

export const busyEvent = z.strictObject({
	...base,
	type: z.literal("busy"),
	/** The call that was already active. */
	activeCallId: callId,
});

export const endedEvent = z.strictObject({
	...base,
	type: z.literal("ended"),
	reason: z.enum(["playback_finished", "caller_hung_up", "abandoned"]),
});

export const phoneEvent = z.discriminatedUnion("type", [
	ringingEvent,
	acceptedEvent,
	missedEvent,
	busyEvent,
	endedEvent,
]);

export type PhoneEvent = z.infer<typeof phoneEvent>;
export type PhoneEventType = PhoneEvent["type"];

/** Messages older than this are useless (a stale "ringing"); the queue drops them. */
export const EVENT_TTL_SECONDS = 5 * 60;

/** Sends call events to Pixel. Rejects when the queue can't be reached in time. */
export interface EventPublisher {
	publish(event: PhoneEvent): Promise<void>;
}

const who = (call: Call) => ({
	version: 1 as const,
	callId: call.callId,
	...(call.from ? { from: call.from } : {}),
	...(call.to ? { to: call.to } : {}),
});

/** The event for a call that just changed, as of `at`. */
export const eventFor = {
	ringing: (call: Call, at: Date): PhoneEvent => ({
		...who(call),
		type: "ringing",
		occurredAt: at.toISOString(),
		acceptBy: call.acceptBy.toISOString(),
	}),
	accepted: (call: Call, at: Date): PhoneEvent => ({
		...who(call),
		type: "accepted",
		occurredAt: at.toISOString(),
		via: call.acceptedBy?.via ?? "unknown",
		...(call.acceptedBy?.by ? { by: call.acceptedBy.by } : {}),
	}),
	missed: (call: Call, at: Date): PhoneEvent => ({
		...who(call),
		type: "missed",
		occurredAt: at.toISOString(),
		reason: call.missedReason ?? "timeout",
	}),
	busy: (call: Call, at: Date, activeCallId: string): PhoneEvent => ({
		...who(call),
		type: "busy",
		occurredAt: at.toISOString(),
		activeCallId,
	}),
	ended: (call: Call, at: Date): PhoneEvent => ({
		...who(call),
		type: "ended",
		occurredAt: at.toISOString(),
		reason: call.endedReason ?? "playback_finished",
	}),
};

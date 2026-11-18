/**
 * What the telephony platform tells us about a call, in the core's words. The Telnyx
 * adapter turns verified webhooks into these; the call flow (#16) acts on them.
 */

/** The events the call flow acts on. Anything else is logged and acknowledged. */
export const TELEPHONY_EVENT_TYPES = [
	"call.initiated",
	"call.answered",
	"call.playback.ended",
	"call.hangup",
] as const;
export type TelephonyEventType = (typeof TELEPHONY_EVENT_TYPES)[number];

export type TelephonyEvent = {
	/** The platform's event ID, unique per event. Used to drop duplicates. */
	id: string;
	type: TelephonyEventType;
	occurredAt: Date;
	callControlId: string;
	callLegId?: string;
	callSessionId?: string;
	from?: string;
	to?: string;
	direction?: "incoming" | "outgoing";
	/** Our call ID, echoed back from the client state we sent with a command. */
	callId?: string;
	hangupCause?: string;
};

/** Receives verified, de-duplicated events. Implemented by the call flow (#16). */
export interface TelephonyEventHandler {
	handle(event: TelephonyEvent): Promise<void>;
}

/**
 * Remembers which event IDs have been seen, so a redelivered event is handled once.
 * `firstSeen` returns true the first time an ID is recorded and false afterwards.
 */
export interface SeenEvents {
	firstSeen(eventId: string, at: Date): Promise<boolean>;
}

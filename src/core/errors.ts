/** Base class for errors the call flow raises on purpose, so callers can tell them from bugs. */
export class PixelPhoneError extends Error {
	override name = "PixelPhoneError";
}

/** The telephony platform says the call has already ended (Telnyx 90018). */
export class CallGone extends PixelPhoneError {
	override name = "CallGone";
}

/** A command the platform refused because we used it wrong (e.g. Telnyx 90034). A bug. */
export class TelephonyMisuse extends PixelPhoneError {
	override name = "TelephonyMisuse";
}

/** A command failed for another reason: a timeout, the network, a 5xx, an unexpected 4xx. */
export class TelephonyFailed extends PixelPhoneError {
	override name = "TelephonyFailed";
}

/** There's no call to accept: none is ringing, or that call ID doesn't exist. */
export class NoSuchCall extends PixelPhoneError {
	override name = "NoSuchCall";
}

/** Someone else accepted first. Says who. */
export class AlreadyAccepted extends PixelPhoneError {
	override name = "AlreadyAccepted";
	constructor(
		readonly callId: string,
		readonly winner: { via: string; by?: string } | undefined,
	) {
		super(`call ${callId} was already accepted`);
	}
}

/** The accept window has passed, or the call is over. */
export class AcceptTooLate extends PixelPhoneError {
	override name = "AcceptTooLate";
	constructor(readonly callId: string) {
		super(`call ${callId} can no longer be accepted`);
	}
}

/** A conditional write lost: the row changed since it was read. */
export class StoreConflict extends PixelPhoneError {
	override name = "StoreConflict";
}

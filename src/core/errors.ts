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

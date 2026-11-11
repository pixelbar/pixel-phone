/** Base class for errors the call flow raises on purpose, so callers can tell them from bugs. */
export class PixelPhoneError extends Error {
	override name = "PixelPhoneError";
}

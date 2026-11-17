/**
 * Where the recordings are (ADR 0008). The flow asks for a URL Telnyx can fetch, valid
 * only briefly; the recordings themselves are never public.
 */
export interface Media {
	/** A short-lived, read-only URL for the recording `name`. */
	urlFor(name: string): Promise<string>;
	/** Whether `name` exists, for the startup check. */
	exists(name: string): Promise<boolean>;
}

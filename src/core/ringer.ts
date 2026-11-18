/**
 * Rings the space (ADR 0005). pixel-phone only says "a call is ringing" or "it isn't";
 * Home Assistant decides whether the siren sounds, and turns it off.
 * `ringing` rejects when the platform can't be told; the call flow decides what then.
 */
export interface Ringer {
	ringing(on: boolean): Promise<void>;
}

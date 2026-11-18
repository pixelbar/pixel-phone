/**
 * The commands the call flow sends the telephony platform (ADR 0002). There is no
 * `reject`: until someone accepts, we send nothing, and the call rings out.
 *
 * Every method throws `CallGone` when the caller has already hung up, `TelephonyMisuse`
 * when the platform says we used it wrong, and `TelephonyFailed` otherwise.
 * `callId` is our own ID; the platform echoes it back on the events the command causes.
 */
export interface Telephony {
	answer(callControlId: string, callId: string): Promise<void>;
	play(callControlId: string, audioUrl: string, callId: string): Promise<void>;
	hangup(callControlId: string, callId: string): Promise<void>;
}

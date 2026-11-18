/**
 * A Telephony that records commands in order and, like Telnyx, answers each with the
 * webhook event it causes: answer → call.answered, play → call.playback.ended (when the
 * test says the recording finished, or at once with `autoFinishPlayback`), hangup →
 * call.hangup. Failures can be queued per command.
 */
import { CallGone } from "../core/errors.ts";
import type { Telephony } from "../core/telephony.ts";
import type { TelephonyEvent, TelephonyEventHandler } from "../core/telephony-events.ts";

export type Command =
	| { action: "answer"; callControlId: string; callId: string }
	| { action: "play"; callControlId: string; callId: string; audioUrl: string }
	| { action: "hangup"; callControlId: string; callId: string };

let eventCounter = 0;

export class FakeTelephony implements Telephony {
	readonly commands: Command[] = [];
	/** Errors thrown by the next commands of that kind, in order. */
	readonly failures: Partial<Record<Command["action"], Error[]>> = {};
	/** Where the events the commands cause are sent. Set by the test. */
	handler: TelephonyEventHandler | undefined;
	autoFinishPlayback = false;
	/** Calls that have ended: any command on them throws CallGone. */
	readonly gone = new Set<string>();
	/** Optional delay before each command returns, in ms of real time. */
	delayMs = 0;

	async answer(callControlId: string, callId: string): Promise<void> {
		await this.run({ action: "answer", callControlId, callId });
		this.emit("call.answered", callControlId, callId);
	}

	async play(callControlId: string, audioUrl: string, callId: string): Promise<void> {
		await this.run({ action: "play", callControlId, callId, audioUrl });
		if (this.autoFinishPlayback) this.emit("call.playback.ended", callControlId, callId);
	}

	async hangup(callControlId: string, callId: string): Promise<void> {
		await this.run({ action: "hangup", callControlId, callId });
		this.gone.add(callControlId);
		this.emit("call.hangup", callControlId, callId, "normal_clearing");
	}

	/** The recording finished playing: send call.playback.ended. */
	finishPlayback(callControlId: string, callId: string) {
		this.emit("call.playback.ended", callControlId, callId);
	}

	/** The caller hung up. */
	callerHangsUp(callControlId: string, callId?: string) {
		this.gone.add(callControlId);
		this.emit("call.hangup", callControlId, callId, "normal_clearing");
	}

	actions(): string[] {
		return this.commands.map((c) => c.action);
	}

	private async run(command: Command) {
		if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
		this.commands.push(command);
		const failure = this.failures[command.action]?.shift();
		if (failure) throw failure;
		if (this.gone.has(command.callControlId)) throw new CallGone("call has already ended");
	}

	private emit(
		type: TelephonyEvent["type"],
		callControlId: string,
		callId: string | undefined,
		hangupCause?: string,
	) {
		const handler = this.handler;
		if (!handler) return;
		const event: TelephonyEvent = {
			id: `fake-${++eventCounter}`,
			type,
			occurredAt: new Date(),
			callControlId,
			...(callId ? { callId } : {}),
			...(hangupCause ? { hangupCause } : {}),
		};
		setImmediate(() => void handler.handle(event));
	}
}

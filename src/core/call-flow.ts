/**
 * The call flow (ADR 0002): connects verified Telnyx events and accepts to the state
 * machine, and does each transition's side effects.
 *
 * - ringing  → ringer on, publish `ringing` (together). Both failing is reported; the call
 *              still rings out, because we never answered.
 * - busy     → publish `busy`. Nothing else: it rings out.
 * - accepted → answer, then play the accept recording; meanwhile ringer off and publish
 *              `accepted`. If the caller is already gone, the call is `missed`.
 * - missed   → ringer off, publish `missed`. No command to Telnyx.
 * - ended    → hang up if we were still on the line, publish `ended`.
 *
 * Every outcome writes one `call.<outcome>` line with callId, from, to and via/by.
 */
import { CallMachine, type Transition } from "./call-machine.ts";
import type { Acceptor, Call, CallStore } from "./calls.ts";
import type { Clock } from "./clock.ts";
import { CallGone } from "./errors.ts";
import { type EventPublisher, eventFor, type PhoneEvent } from "./events.ts";
import type { Media } from "./media.ts";
import type { Ringer } from "./ringer.ts";
import type { Telephony } from "./telephony.ts";
import type { TelephonyEvent, TelephonyEventHandler } from "./telephony-events.ts";

/** Which dependency failed, for the report. */
export type FailureArea = "telnyx" | "home-assistant" | "queue" | "media" | "storage" | "call-flow";

/** How the flow tells the outside world what happened. Implemented with pino and Sentry. */
export type FlowObserver = {
	log(event: string, fields: Record<string, unknown>): void;
	fail(area: FailureArea, error: unknown, fields: Record<string, unknown>): void;
};

export type CallFlowDeps = {
	store: CallStore;
	clock: Clock;
	telephony: Telephony;
	ringer: Ringer;
	publisher: EventPublisher;
	media: Media;
	recording: string;
	observer: FlowObserver;
	acceptWindowMs?: number;
	/** The guard on each side effect, on top of the adapters' own limits. */
	sideEffectTimeoutMs?: number;
};

const DEFAULT_SIDE_EFFECT_TIMEOUT_MS = 5_000;

export class SideEffectTimeout extends Error {
	override name = "SideEffectTimeout";
}

export class CallFlow implements TelephonyEventHandler {
	readonly machine: CallMachine;
	private readonly deps: CallFlowDeps;
	private readonly timeoutMs: number;
	/** Side effects still running, so tests and shutdown can wait for them. */
	private readonly pending = new Set<Promise<unknown>>();

	constructor(deps: CallFlowDeps) {
		this.deps = deps;
		this.timeoutMs = deps.sideEffectTimeoutMs ?? DEFAULT_SIDE_EFFECT_TIMEOUT_MS;
		this.machine = new CallMachine({
			store: deps.store,
			clock: deps.clock,
			...(deps.acceptWindowMs ? { acceptWindowMs: deps.acceptWindowMs } : {}),
			onTransition: (t) => this.track(this.sideEffects(t)),
			onError: (error, context) => deps.observer.fail("call-flow", error, context),
		});
	}

	/** A verified, de-duplicated Telnyx event. */
	async handle(event: TelephonyEvent): Promise<void> {
		switch (event.type) {
			case "call.initiated":
				if (event.direction === "outgoing") return;
				await this.machine.incoming({
					callControlId: event.callControlId,
					...(event.callSessionId ? { callSessionId: event.callSessionId } : {}),
					...(event.from ? { from: event.from } : {}),
					...(event.to ? { to: event.to } : {}),
				});
				return;
			case "call.answered":
				this.deps.observer.log("call.answered_by_telnyx", {
					callControlId: event.callControlId,
					...(event.callId ? { callId: event.callId } : {}),
				});
				return;
			case "call.playback.ended":
				await this.machine.playbackFinished(event.callControlId);
				return;
			case "call.hangup":
				await this.machine.hungUp(event.callControlId);
				return;
		}
	}

	/** From the accept API. Throws NoSuchCall, AlreadyAccepted or AcceptTooLate. */
	accept(target: string, acceptor: Acceptor): Promise<Call> {
		return this.machine.accept(target, acceptor);
	}

	/** On startup: recover calls a restart left behind, and check the recording exists. */
	async start(): Promise<void> {
		try {
			const recovered = await this.machine.recover();
			if (recovered.length > 0) {
				this.deps.observer.log("call.recovered", { count: recovered.length });
			}
		} catch (error) {
			this.deps.observer.fail("storage", error, { during: "recovering calls" });
		}
		try {
			if (!(await this.deps.media.exists(this.deps.recording))) {
				this.deps.observer.fail(
					"media",
					new Error(`accept recording ${this.deps.recording} is missing`),
					{ recording: this.deps.recording },
				);
			}
		} catch (error) {
			this.deps.observer.fail("media", error, { during: "checking the accept recording" });
		}
	}

	/** Waits for side effects in flight. */
	async idle(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}

	stop() {
		this.machine.stop();
	}

	// --- side effects -------------------------------------------------------------

	private track<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		void promise.finally(() => this.pending.delete(promise)).catch(() => {});
		return promise;
	}

	private async sideEffects(t: Transition): Promise<void> {
		const { call } = t;
		const now = this.deps.clock.now();
		switch (t.type) {
			case "ringing": {
				const [ring, publish] = await Promise.all([
					this.ring(call, true),
					this.publish(eventFor.ringing(call, now), call),
				]);
				if (!ring && !publish) {
					this.deps.observer.fail(
						"call-flow",
						new Error("Neither Home Assistant nor the queue was told about the call"),
						fields(call),
					);
				}
				this.deps.observer.log("call.ringing", {
					...fields(call),
					acceptBy: call.acceptBy.toISOString(),
					ringer: ring,
					queue: publish,
				});
				return;
			}
			case "busy":
				await this.publish(eventFor.busy(call, now, t.activeCallId), call);
				this.deps.observer.log("call.busy", { ...fields(call), activeCallId: t.activeCallId });
				return;
			case "accepted":
				this.deps.observer.log("call.accepted", fields(call));
				await Promise.all([
					this.answerAndPlay(call),
					this.ring(call, false),
					this.publish(eventFor.accepted(call, now), call),
				]);
				return;
			case "missed":
				await Promise.all([this.ring(call, false), this.publish(eventFor.missed(call, now), call)]);
				this.deps.observer.log("call.missed", { ...fields(call), reason: call.missedReason });
				return;
			case "ended":
				if (call.endedReason !== "caller_hung_up") await this.hangup(call);
				await this.publish(eventFor.ended(call, now), call);
				this.deps.observer.log("call.ended", { ...fields(call), reason: call.endedReason });
				return;
		}
	}

	private async answerAndPlay(call: Call): Promise<void> {
		const { telephony, media, recording, observer } = this.deps;
		try {
			await this.limit(telephony.answer(call.callControlId, call.callId));
		} catch (error) {
			if (error instanceof CallGone) {
				await this.machine.answerFoundCallGone(call.callId);
				return;
			}
			// Not answered: the call keeps ringing, and ends when OpenR gives up.
			observer.fail("telnyx", error, { ...fields(call), during: "answer" });
			return;
		}
		let url: string;
		try {
			url = await this.limit(media.urlFor(recording));
		} catch (error) {
			observer.fail("media", error, { ...fields(call), during: "signing the recording URL" });
			await this.hangup(call);
			return;
		}
		try {
			await this.limit(telephony.play(call.callControlId, url, call.callId));
		} catch (error) {
			if (error instanceof CallGone) return; // the hang-up event ends the call
			observer.fail("telnyx", error, { ...fields(call), during: "play" });
			await this.hangup(call);
		}
	}

	private async hangup(call: Call): Promise<void> {
		try {
			await this.limit(this.deps.telephony.hangup(call.callControlId, call.callId));
		} catch (error) {
			if (error instanceof CallGone) return;
			this.deps.observer.fail("telnyx", error, { ...fields(call), during: "hangup" });
		}
	}

	/** Tells the ringer; returns whether it worked. Safe to repeat. */
	private async ring(call: Call, on: boolean): Promise<boolean> {
		try {
			await this.limit(this.deps.ringer.ringing(on));
			return true;
		} catch (error) {
			this.deps.observer.fail("home-assistant", error, { ...fields(call), ringing: on });
			return false;
		}
	}

	private async publish(event: PhoneEvent, call: Call): Promise<boolean> {
		try {
			await this.limit(this.deps.publisher.publish(event));
			return true;
		} catch (error) {
			this.deps.observer.fail("queue", error, { ...fields(call), type: event.type });
			return false;
		}
	}

	private limit<T>(promise: Promise<T>): Promise<T> {
		let cancel: (() => void) | undefined;
		const timeout = new Promise<never>((_, reject) => {
			cancel = this.deps.clock.setTimer(this.timeoutMs, () =>
				reject(new SideEffectTimeout(`no answer within ${this.timeoutMs} ms`)),
			);
		});
		return Promise.race([promise, timeout]).finally(() => cancel?.());
	}
}

function fields(call: Call): Record<string, unknown> {
	return {
		callId: call.callId,
		...(call.from ? { from: call.from } : {}),
		...(call.to ? { to: call.to } : {}),
		...(call.acceptedBy ? { via: call.acceptedBy.via } : {}),
		...(call.acceptedBy?.by ? { by: call.acceptedBy.by } : {}),
	};
}

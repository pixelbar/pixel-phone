/**
 * The call state machine (ADR 0002, ADR 0004). It decides what state a call is in and
 * keeps the accept window's timer. It sends no commands itself: every change is handed to
 * `onTransition`, where the call flow (#16) does the side effects (answer, ringer, queue).
 *
 * Changes are made one at a time in this process, and each write is conditional on the
 * row's ETag, so two accepts can't both win even across replicas during a deploy.
 */

import {
	type Acceptor,
	CALL_ID_PATTERN,
	type Call,
	type CallStore,
	type EndedReason,
	type MissedReason,
	newCallId,
	sameCall,
} from "./calls.ts";
import type { Clock } from "./clock.ts";
import { AcceptTooLate, AlreadyAccepted, NoSuchCall, StoreConflict } from "./errors.ts";

export type Transition =
	| { type: "ringing"; call: Call }
	| { type: "busy"; call: Call; activeCallId: string }
	| { type: "accepted"; call: Call }
	| { type: "missed"; call: Call }
	| { type: "ended"; call: Call };

export const DEFAULT_ACCEPT_WINDOW_MS = 15_000;

/**
 * An accepted call that never hears `call.playback.ended` or `call.hangup` (a lost
 * webhook) stops counting as active after this, so it can't block the doorbell.
 */
export const ACCEPTING_MAX_MS = 3 * 60_000;

/** How many times a write is retried after losing a conditional update. */
const MAX_CONFLICT_RETRIES = 3;

export type CallMachineDeps = {
	store: CallStore;
	clock: Clock;
	acceptWindowMs?: number;
	/** Called after each change, outside the lock. Not awaited by the caller. */
	onTransition?: (transition: Transition) => Promise<void>;
	/** Where a failing `onTransition` or timer goes. */
	onError?: (error: unknown, context: Record<string, unknown>) => void;
};

export type IncomingCall = {
	callControlId: string;
	callSessionId?: string;
	from?: string;
	to?: string;
};

export class CallMachine {
	private readonly store: CallStore;
	private readonly clock: Clock;
	readonly acceptWindowMs: number;
	private readonly onTransition: CallMachineDeps["onTransition"];
	private readonly onError: NonNullable<CallMachineDeps["onError"]>;
	private readonly timers = new Map<string, () => void>();
	private tail: Promise<unknown> = Promise.resolve();

	constructor(deps: CallMachineDeps) {
		this.store = deps.store;
		this.clock = deps.clock;
		this.acceptWindowMs = deps.acceptWindowMs ?? DEFAULT_ACCEPT_WINDOW_MS;
		this.onTransition = deps.onTransition;
		this.onError = deps.onError ?? (() => {});
	}

	/** A new incoming call: `ringing`, or `busy` if another call is active. */
	incoming(input: IncomingCall): Promise<Transition | undefined> {
		return this.run(async (emit) => {
			// Telnyx can send call.initiated twice; the first one made the row.
			if (await this.store.findByControlId(input.callControlId)) return undefined;
			const active = await this.liveActive(emit);
			const now = this.clock.now();
			const call: Call = {
				callId: newCallId(now),
				callControlId: input.callControlId,
				...(input.callSessionId ? { callSessionId: input.callSessionId } : {}),
				...(input.from ? { from: input.from } : {}),
				...(input.to ? { to: input.to } : {}),
				status: active ? "busy" : "ringing",
				createdAt: now,
				updatedAt: now,
				acceptBy: new Date(now.getTime() + this.acceptWindowMs),
			};
			try {
				await this.store.create(call);
			} catch (error) {
				// Our own insert, retried after its reply was lost, conflicts with itself.
				const stored =
					error instanceof StoreConflict ? await this.store.get(call.callId) : undefined;
				if (!stored || !sameCall(stored.value, call)) throw error;
			}
			if (active) return emit({ type: "busy", call, activeCallId: active.callId });
			this.startTimer(call.callId, this.acceptWindowMs);
			return emit({ type: "ringing", call });
		});
	}

	/**
	 * Accepts a call: the one ringing now (`"current"`), or one by ID. The first accept
	 * wins. Throws `NoSuchCall`, `AlreadyAccepted` or `AcceptTooLate`.
	 */
	accept(target: string, acceptor: Acceptor): Promise<Call> {
		return this.run(async (emit) => {
			const callId = target === "current" ? await this.currentCallId() : target;
			if (!CALL_ID_PATTERN.test(callId)) throw new NoSuchCall(`no call ${callId}`);
			const changed = await this.change(callId, (call, now) => {
				if (call.acceptedBy) throw new AlreadyAccepted(call.callId, call.acceptedBy);
				if (call.status !== "ringing" || now > call.acceptBy) {
					throw new AcceptTooLate(call.callId);
				}
				return {
					...call,
					status: "accepting",
					acceptedBy: acceptor,
					acceptedAt: now,
					updatedAt: now,
				};
			});
			if (!changed) throw new NoSuchCall(`no call ${callId}`);
			this.stopTimer(callId);
			emit({ type: "accepted", call: changed });
			return changed;
		});
	}

	/** The accept window passed with nobody accepting. No command: the call rings out. */
	windowEnded(callId: string): Promise<Transition | undefined> {
		return this.run((emit) => this.miss(callId, "timeout", emit));
	}

	/** Telnyx says the call hung up (call.hangup). */
	hungUp(callControlId: string): Promise<Transition | undefined> {
		return this.run(async (emit) => {
			const found = await this.store.findByControlId(callControlId);
			if (!found) return undefined;
			const { callId, status } = found.value;
			if (status === "ringing") return this.miss(callId, "caller_hung_up", emit);
			if (status === "accepting") return this.end(callId, "caller_hung_up", emit);
			return undefined;
		});
	}

	/** Answering failed because the caller had already gone (CallGone). */
	answerFoundCallGone(callId: string): Promise<Transition | undefined> {
		return this.run((emit) => this.miss(callId, "caller_hung_up", emit, "accepting"));
	}

	/** The accept recording finished (call.playback.ended). The flow hangs up. */
	playbackFinished(callControlId: string): Promise<Transition | undefined> {
		return this.run(async (emit) => {
			const found = await this.store.findByControlId(callControlId);
			if (found?.value.status !== "accepting") return undefined;
			return this.end(found.value.callId, "playback_finished", emit);
		});
	}

	/**
	 * After a restart: calls left `ringing` past their window are missed, ones still in
	 * their window get their timer back, and accepted calls stuck for minutes are ended.
	 */
	recover(): Promise<Transition[]> {
		return this.run(async (emit) => {
			const out: Transition[] = [];
			const capture: Emit = (t) => {
				out.push(t);
				return emit(t);
			};
			const now = this.clock.now().getTime();
			for (const { value: call } of await this.store.active()) {
				if (call.status === "ringing") {
					const left = call.acceptBy.getTime() - now;
					if (left > 0) this.startTimer(call.callId, left);
					else await this.miss(call.callId, "timeout", capture);
				} else if (isStuck(call, now)) {
					await this.end(call.callId, "abandoned", capture);
				}
			}
			return out;
		});
	}

	/** Stops the timers, for shutdown and tests. */
	stop() {
		for (const cancel of this.timers.values()) cancel();
		this.timers.clear();
	}

	// --- internals ----------------------------------------------------------------

	/** The live active call, after retiring stale ones (a lost timer or webhook). */
	private async liveActive(emit: Emit): Promise<Call | undefined> {
		const now = this.clock.now().getTime();
		let live: Call | undefined;
		for (const { value: call } of await this.store.active()) {
			if (call.status === "ringing" && call.acceptBy.getTime() <= now) {
				await this.miss(call.callId, "timeout", emit);
			} else if (call.status === "accepting" && isStuck(call, now)) {
				await this.end(call.callId, "abandoned", emit);
			} else if (!live || call.createdAt > live.createdAt) {
				live = call;
			}
		}
		return live;
	}

	private async currentCallId(): Promise<string> {
		const active = (await this.store.active()).map((v) => v.value);
		const ringing = active
			.filter((c) => c.status === "ringing")
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
		if (ringing) return ringing.callId;
		const accepting = active.find((c) => c.status === "accepting");
		if (accepting) throw new AlreadyAccepted(accepting.callId, accepting.acceptedBy);
		throw new NoSuchCall("no call is ringing");
	}

	private async miss(
		callId: string,
		reason: MissedReason,
		emit: Emit,
		from: "ringing" | "accepting" = "ringing",
	): Promise<Transition | undefined> {
		const changed = await this.change(callId, (call, now) =>
			call.status === from
				? { ...call, status: "missed", missedReason: reason, endedAt: now, updatedAt: now }
				: undefined,
		);
		this.stopTimer(callId);
		return changed ? emit({ type: "missed", call: changed }) : undefined;
	}

	private async end(
		callId: string,
		reason: EndedReason,
		emit: Emit,
	): Promise<Transition | undefined> {
		const changed = await this.change(callId, (call, now) =>
			call.status === "accepting"
				? { ...call, status: "ended", endedReason: reason, endedAt: now, updatedAt: now }
				: undefined,
		);
		return changed ? emit({ type: "ended", call: changed }) : undefined;
	}

	/**
	 * Reads the call, applies `mutate`, and writes it back conditionally, re-reading after a
	 * lost race. `mutate` returns undefined for "nothing to do" and may throw.
	 */
	private async change(
		callId: string,
		mutate: (call: Call, now: Date) => Call | undefined,
	): Promise<Call | undefined> {
		for (let attempt = 0; ; attempt++) {
			const found = await this.store.get(callId);
			if (!found) return undefined;
			const next = mutate(found.value, this.clock.now());
			if (!next) return undefined;
			try {
				await this.store.update(next, found.etag);
				return next;
			} catch (error) {
				if (!(error instanceof StoreConflict)) throw error;
				// The write may have landed and only its reply been lost: then the row is ours.
				const now = await this.store.get(callId);
				if (now && sameCall(now.value, next)) return next;
				if (attempt >= MAX_CONFLICT_RETRIES) throw error;
			}
		}
	}

	private startTimer(callId: string, ms: number) {
		this.stopTimer(callId);
		const cancel = this.clock.setTimer(ms, () => {
			this.timers.delete(callId);
			this.windowEnded(callId).catch((error: unknown) =>
				this.onError(error, { during: "accept window timer", callId }),
			);
		});
		this.timers.set(callId, cancel);
	}

	private stopTimer(callId: string) {
		this.timers.get(callId)?.();
		this.timers.delete(callId);
	}

	/** Runs `fn` after every earlier change, then hands its transitions to the listener. */
	private run<T>(fn: (emit: Emit) => Promise<T>): Promise<T> {
		const emitted: Transition[] = [];
		const emit: Emit = (t) => {
			emitted.push(t);
			return t;
		};
		const result = this.tail.then(() => fn(emit));
		this.tail = result.catch(() => {});
		return result.finally(() => {
			for (const t of emitted) this.notify(t);
		});
	}

	private notify(transition: Transition) {
		if (!this.onTransition) return;
		const context = { during: `${transition.type} side effects`, callId: transition.call.callId };
		try {
			this.onTransition(transition).catch((error: unknown) => this.onError(error, context));
		} catch (error) {
			this.onError(error, context);
		}
	}
}

type Emit = <T extends Transition>(t: T) => T;

function isStuck(call: Call, now: number): boolean {
	const since = (call.acceptedAt ?? call.updatedAt).getTime();
	return now - since > ACCEPTING_MAX_MS;
}

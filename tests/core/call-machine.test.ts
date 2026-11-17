import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCallStore } from "../../src/adapters/memory/call-store.ts";
import {
	ACCEPTING_MAX_MS,
	CallMachine,
	type IncomingCall,
	type Transition,
} from "../../src/core/call-machine.ts";
import { type Call, isActive, newCallId } from "../../src/core/calls.ts";
import {
	AcceptTooLate,
	AlreadyAccepted,
	NoSuchCall,
	StoreConflict,
} from "../../src/core/errors.ts";
import { FakeClock, flush } from "../../src/testing/fake-clock.ts";

const machines: CallMachine[] = [];
afterEach(() => {
	for (const m of machines.splice(0)) m.stop();
});

function setup(options: { store?: MemoryCallStore; clock?: FakeClock } = {}) {
	const store = options.store ?? new MemoryCallStore();
	const clock = options.clock ?? new FakeClock();
	const transitions: Transition[] = [];
	const errors: unknown[] = [];
	const machine = new CallMachine({
		store,
		clock,
		onTransition: async (t) => {
			transitions.push(t);
		},
		onError: (e) => errors.push(e),
	});
	machines.push(machine);
	const types = () => transitions.map((t) => t.type);
	return { store, clock, machine, transitions, types, errors };
}

const DOOR = { callControlId: "v3:door-1", from: "+31201234567", to: "+31103024128" };
const HA = { via: "home-assistant" };
const PIXEL = { via: "pixel", by: "discord:42" };

async function ringing(s: ReturnType<typeof setup>, input: IncomingCall = DOOR): Promise<Call> {
	const t = await s.machine.incoming(input);
	if (t?.type !== "ringing") throw new Error(`expected ringing, got ${t?.type}`);
	return t.call;
}

describe("incoming call", () => {
	it("with no active call: saved as ringing with a 15 s window, and emits ringing", async () => {
		const s = setup();
		const call = await ringing(s);
		expect(call).toMatchObject({
			status: "ringing",
			from: DOOR.from,
			to: DOOR.to,
			callControlId: DOOR.callControlId,
		});
		expect(call.acceptBy.getTime() - call.createdAt.getTime()).toBe(15_000);
		expect(call.callId).toMatch(/^20261118-[0-9a-f]{12}$/);
		await flush();
		expect(s.types()).toEqual(["ringing"]);
		expect(s.clock.pendingTimers).toBe(1);
	});

	it("while another call is active: busy, no timer, and the active call is untouched", async () => {
		const s = setup();
		const first = await ringing(s);
		const second = await s.machine.incoming({ callControlId: "v3:door-2" });
		expect(second).toMatchObject({ type: "busy", activeCallId: first.callId });
		expect(second?.call.status).toBe("busy");
		expect((await s.store.get(first.callId))?.value.status).toBe("ringing");
		expect(s.clock.pendingTimers).toBe(1);
	});

	it("is busy while a call is being answered too", async () => {
		const s = setup();
		const first = await ringing(s);
		await s.machine.accept(first.callId, HA);
		expect((await s.machine.incoming({ callControlId: "v3:door-2" }))?.type).toBe("busy");
	});

	it("ignores a repeated call.initiated for the same call", async () => {
		const s = setup();
		await ringing(s);
		expect(await s.machine.incoming(DOOR)).toBeUndefined();
		expect(s.store.all()).toHaveLength(1);
	});

	it("retires a ringing call whose timer was lost, instead of staying busy forever", async () => {
		const s = setup();
		const stale = await ringing(s);
		s.machine.stop(); // the timer is gone, as after a crash
		await s.clock.advance(16_000);
		const next = await s.machine.incoming({ callControlId: "v3:door-2" });
		expect(next?.type).toBe("ringing");
		expect((await s.store.get(stale.callId))?.value).toMatchObject({
			status: "missed",
			missedReason: "timeout",
		});
	});

	it("retires an accepted call stuck for minutes", async () => {
		const s = setup();
		const stuck = await ringing(s);
		await s.machine.accept(stuck.callId, HA);
		await s.clock.advance(ACCEPTING_MAX_MS + 1000);
		expect((await s.machine.incoming({ callControlId: "v3:door-2" }))?.type).toBe("ringing");
		expect((await s.store.get(stuck.callId))?.value).toMatchObject({
			status: "ended",
			endedReason: "abandoned",
		});
	});
});

describe("accept", () => {
	it("while ringing, before the window ends: accepting, recording who, first writer wins", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.clock.advance(14_000);
		const accepted = await s.machine.accept(call.callId, PIXEL);
		expect(accepted).toMatchObject({ status: "accepting", acceptedBy: PIXEL });
		expect(accepted.acceptedAt).toEqual(s.clock.now());
		await flush();
		expect(s.types()).toEqual(["ringing", "accepted"]);
		expect(s.clock.pendingTimers).toBe(0);
	});

	it("'current' accepts the call ringing now", async () => {
		const s = setup();
		const call = await ringing(s);
		expect((await s.machine.accept("current", HA)).callId).toBe(call.callId);
	});

	it("a second accept gets AlreadyAccepted with the winner", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		const error = await s.machine.accept(call.callId, PIXEL).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AlreadyAccepted);
		expect((error as AlreadyAccepted).winner).toEqual(HA);
		const current = await s.machine.accept("current", PIXEL).catch((e: unknown) => e);
		expect(current).toBeInstanceOf(AlreadyAccepted);
	});

	it("after the window, or once missed or ended: AcceptTooLate", async () => {
		const s = setup();
		const call = await ringing(s);
		s.machine.stop();
		await s.clock.advance(15_001);
		await expect(s.machine.accept(call.callId, HA)).rejects.toBeInstanceOf(AcceptTooLate);
		await s.machine.windowEnded(call.callId);
		await expect(s.machine.accept(call.callId, HA)).rejects.toBeInstanceOf(AcceptTooLate);

		const busy = await s.machine.incoming({ callControlId: "v3:x" });
		const late = busy?.type === "ringing" ? busy.call.callId : "";
		await s.machine.hungUp("v3:x");
		await expect(s.machine.accept(late, HA)).rejects.toBeInstanceOf(AcceptTooLate);
	});

	it("no such call: NoSuchCall", async () => {
		const s = setup();
		await expect(s.machine.accept("current", HA)).rejects.toBeInstanceOf(NoSuchCall);
		await expect(s.machine.accept("not-an-id", HA)).rejects.toBeInstanceOf(NoSuchCall);
		await expect(s.machine.accept(newCallId(s.clock.now()), HA)).rejects.toBeInstanceOf(NoSuchCall);
	});

	it("two accepts racing on the same ETag, from two replicas: exactly one winner", async () => {
		const store = new MemoryCallStore();
		const clock = new FakeClock();
		const a = setup({ store, clock });
		const b = setup({ store, clock });
		const call = await ringing(a);
		const results = await Promise.allSettled([
			a.machine.accept(call.callId, HA),
			b.machine.accept(call.callId, PIXEL),
		]);
		const won = results.filter((r) => r.status === "fulfilled");
		const lost = results.filter((r) => r.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyAccepted);
		expect((await store.get(call.callId))?.value.acceptedBy).toEqual(HA);
	});

	it("re-reads after losing a conditional write, and gives up after a few", async () => {
		const s = setup();
		const call = await ringing(s);
		let races = 0;
		s.store.beforeUpdate = (c) => {
			if (races++ < 2) {
				// Someone else writes the same row first (an unrelated field), bumping the ETag.
				const row = (s.store as unknown as { rows: Map<string, { version: number }> }).rows.get(
					c.callId,
				);
				if (row) row.version++;
			}
		};
		expect((await s.machine.accept(call.callId, HA)).status).toBe("accepting");

		const other = setup();
		const call2 = await ringing(other);
		other.store.beforeUpdate = () => {
			throw new StoreConflict("always");
		};
		await expect(other.machine.accept(call2.callId, HA)).rejects.toBeInstanceOf(StoreConflict);
	});
});

describe("leaving ringing without an accept", () => {
	it("the window ends: missed (timeout), with no other effect", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.clock.advance(15_000);
		expect((await s.store.get(call.callId))?.value).toMatchObject({
			status: "missed",
			missedReason: "timeout",
		});
		expect(s.types()).toEqual(["ringing", "missed"]);
	});

	it("the caller hangs up: missed (caller_hung_up), and the timer is stopped", async () => {
		const s = setup();
		const call = await ringing(s);
		const t = await s.machine.hungUp(DOOR.callControlId);
		expect(t?.call).toMatchObject({ status: "missed", missedReason: "caller_hung_up" });
		expect(s.clock.pendingTimers).toBe(0);
		await s.clock.advance(20_000);
		await flush();
		expect(s.types()).toEqual(["ringing", "missed"]);
		expect((await s.store.get(call.callId))?.value.missedReason).toBe("caller_hung_up");
	});
});

describe("after an accept", () => {
	it("answering finds the call gone: missed (caller_hung_up)", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		const t = await s.machine.answerFoundCallGone(call.callId);
		expect(t?.call).toMatchObject({ status: "missed", missedReason: "caller_hung_up" });
	});

	it("the recording ends: ended (playback_finished); the flow then hangs up", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		const t = await s.machine.playbackFinished(DOOR.callControlId);
		expect(t).toMatchObject({
			type: "ended",
			call: { status: "ended", endedReason: "playback_finished" },
		});
		expect(await s.machine.playbackFinished(DOOR.callControlId)).toBeUndefined();
	});

	it("the caller hangs up during the recording: ended (caller_hung_up)", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		const t = await s.machine.hungUp(DOOR.callControlId);
		expect(t?.call).toMatchObject({ status: "ended", endedReason: "caller_hung_up" });
		// Our own hang-up after the recording also sends call.hangup: nothing more happens.
		expect(await s.machine.hungUp(DOOR.callControlId)).toBeUndefined();
	});

	it("ignores events for calls it doesn't know, or in the wrong state", async () => {
		const s = setup();
		expect(await s.machine.hungUp("v3:unknown")).toBeUndefined();
		expect(await s.machine.playbackFinished("v3:unknown")).toBeUndefined();
		expect(await s.machine.windowEnded(newCallId(s.clock.now()))).toBeUndefined();
		const call = await ringing(s);
		expect(await s.machine.answerFoundCallGone(call.callId)).toBeUndefined();
		expect(await s.machine.playbackFinished(DOOR.callControlId)).toBeUndefined();
		const busy = await s.machine.incoming({ callControlId: "v3:busy" });
		expect(busy?.type).toBe("busy");
		expect(await s.machine.hungUp("v3:busy")).toBeUndefined();
	});
});

describe("recover (on startup)", () => {
	it("misses calls left ringing past their window, re-arms ones still in it, ends stuck ones", async () => {
		const store = new MemoryCallStore();
		const clock = new FakeClock();
		const before = setup({ store, clock });
		const late = await ringing(before, { callControlId: "v3:late" });
		before.machine.stop();
		await clock.advance(10_000);
		// Written by "another process" so both exist at once.
		const base = { createdAt: clock.now(), updatedAt: clock.now() };
		const fresh: Call = {
			callId: newCallId(clock.now()),
			callControlId: "v3:fresh",
			status: "ringing",
			acceptBy: new Date(clock.now().getTime() + 10_000),
			...base,
		};
		await store.create(fresh);
		const stuck: Call = {
			callId: newCallId(clock.now()),
			callControlId: "v3:stuck",
			status: "accepting",
			acceptBy: clock.now(),
			acceptedBy: HA,
			acceptedAt: new Date(clock.now().getTime() - ACCEPTING_MAX_MS - 1),
			...base,
		};
		await store.create(stuck);
		await clock.advance(6_000);

		const after = setup({ store, clock });
		const recovered = await after.machine.recover();
		expect(recovered.map((t) => [t.type, t.call.callId])).toEqual([
			["missed", late.callId],
			["ended", stuck.callId],
		]);
		expect(clock.pendingTimers).toBe(1);
		await clock.advance(4_000);
		expect((await store.get(fresh.callId))?.value.status).toBe("missed");
		expect((await store.active()).map((v) => v.value).filter(isActive)).toEqual([]);
	});
});

describe("edge cases", () => {
	type Rows = { rows: Map<string, { call: Call; version: number }> };
	const rowOf = (store: MemoryCallStore, callId: string) => {
		const row = (store as unknown as Rows).rows.get(callId);
		if (!row) throw new Error("no row");
		return row;
	};

	it("keeps the session ID, and picks the newest of several active calls", async () => {
		const s = setup();
		const call = await ringing(s, { callControlId: "v3:a", callSessionId: "sess" });
		expect(call.callSessionId).toBe("sess");
		// Two active rows at once (two replicas during a deploy): busy names the newest.
		await s.clock.advance(1000);
		const other: Call = {
			...call,
			callId: newCallId(s.clock.now()),
			callControlId: "v3:b",
			createdAt: s.clock.now(),
		};
		await s.store.create(other);
		const older: Call = {
			...call,
			callId: newCallId(s.clock.now()),
			callControlId: "v3:c",
			createdAt: new Date(0),
		};
		await s.store.create(older);
		const busy = await s.machine.incoming({ callControlId: "v3:d" });
		expect(busy).toMatchObject({ type: "busy", activeCallId: other.callId });
	});

	it("re-checks the state after losing a race, and does nothing if the call moved on", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		s.store.beforeUpdate = () => {
			s.store.beforeUpdate = undefined;
			const row = rowOf(s.store, call.callId);
			row.call = { ...row.call, status: "ended", endedReason: "caller_hung_up" };
			row.version++;
		};
		expect(await s.machine.playbackFinished(DOOR.callControlId)).toBeUndefined();
	});

	it("recover leaves recent accepted calls alone, and copes with a row missing acceptedAt", async () => {
		const s = setup();
		const call = await ringing(s);
		await s.machine.accept(call.callId, HA);
		expect(await s.machine.recover()).toEqual([]);
		const row = rowOf(s.store, call.callId);
		const { acceptedAt: _, ...withoutAcceptedAt } = row.call;
		row.call = { ...withoutAcceptedAt, updatedAt: new Date(0) };
		expect((await s.machine.recover()).map((t) => t.type)).toEqual(["ended"]);
	});

	it("recognises its own write when the reply was lost and the retry conflicted", async () => {
		const s = setup();
		s.store.loseNextReply = true;
		const call = await ringing(s);
		s.store.loseNextReply = true;
		const accepted = await s.machine.accept(call.callId, HA);
		expect(accepted.status).toBe("accepting");
		await flush();
		expect(s.types()).toEqual(["ringing", "accepted"]);
	});

	it("still fails when a conflicting create holds someone else's row", async () => {
		const s = setup();
		const call = await ringing(s);
		const other = new CallMachine({ store: s.store, clock: s.clock });
		machines.push(other);
		// Same call ID by force: a create that collides with a different row.
		const collide = s.store.create.bind(s.store);
		s.store.create = (c) => collide({ ...c, callId: call.callId });
		s.store.get = async () => ({ value: { ...call, from: "+1999" }, etag: "1" });
		await expect(other.incoming({ callControlId: "v3:other" })).rejects.toBeInstanceOf(
			StoreConflict,
		);
	});

	it("swallows listener errors when no onError is given", async () => {
		const machine = new CallMachine({
			store: new MemoryCallStore(),
			clock: new FakeClock(),
			onTransition: () => Promise.reject(new Error("ignored")),
		});
		machines.push(machine);
		expect((await machine.incoming(DOOR))?.type).toBe("ringing");
		await flush();
	});
});

describe("listener", () => {
	it("reports a failing listener or timer without breaking the machine", async () => {
		const onError = vi.fn();
		const store = new MemoryCallStore();
		const clock = new FakeClock();
		const machine = new CallMachine({
			store,
			clock,
			onTransition: () => Promise.reject(new Error("side effect failed")),
			onError,
		});
		machines.push(machine);
		await machine.incoming(DOOR);
		await flush();
		expect(onError).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ during: "ringing side effects" }),
		);

		const sync = new CallMachine({
			store: new MemoryCallStore(),
			clock,
			onTransition: () => {
				throw new Error("sync throw");
			},
			onError,
		});
		machines.push(sync);
		await sync.incoming(DOOR);
		expect(onError).toHaveBeenCalledTimes(2);

		store.beforeUpdate = () => {
			throw new Error("table down");
		};
		await clock.advance(15_000);
		expect(onError).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ during: "accept window timer" }),
		);
	});

	it("works without a listener", async () => {
		const machine = new CallMachine({ store: new MemoryCallStore(), clock: new FakeClock() });
		machines.push(machine);
		expect((await machine.incoming(DOOR))?.type).toBe("ringing");
	});
});

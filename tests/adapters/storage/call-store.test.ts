import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fromEntity,
	partitionOf,
	TableCallStore,
	toEntity,
} from "../../../src/adapters/storage/call-store.ts";
import { tableClient } from "../../../src/adapters/storage/clients.ts";
import { CallMachine } from "../../../src/core/call-machine.ts";
import { type Call, newCallId } from "../../../src/core/calls.ts";
import { AlreadyAccepted, StoreConflict } from "../../../src/core/errors.ts";
import { FakeClock } from "../../../src/testing/fake-clock.ts";
import { AZURITE, azuriteUp, uniqueName } from "../../helpers/azurite.ts";

const NOW = new Date();

function call(overrides: Partial<Call> = {}): Call {
	return {
		callId: newCallId(NOW),
		callControlId: `v3:${Math.random()}`,
		status: "ringing",
		createdAt: NOW,
		updatedAt: NOW,
		acceptBy: new Date(NOW.getTime() + 15_000),
		...overrides,
	};
}

describe("call entity mapping", () => {
	it("round-trips every field", () => {
		const full = call({
			callSessionId: "sess",
			from: "+31201234567",
			to: "+31103024128",
			status: "ended",
			acceptedBy: { via: "pixel", by: "discord:42" },
			acceptedAt: NOW,
			missedReason: "timeout",
			endedReason: "playback_finished",
			endedAt: NOW,
		});
		expect(fromEntity(toEntity(full))).toEqual(full);
		const minimal = call({ acceptedBy: { via: "home-assistant" } });
		expect(fromEntity(toEntity(minimal))).toEqual(minimal);
		expect(partitionOf("20261118-abcdefabcdef")).toBe("2026-11-18");
	});

	it("refuses a row with a status it doesn't know", () => {
		expect(() => fromEntity({ ...toEntity(call()), status: "weird" })).toThrow(/unknown status/);
	});
});

describe.skipIf(!azuriteUp)("TableCallStore (Azurite)", () => {
	const table = tableClient(
		{ kind: "connection-string", connectionString: AZURITE },
		uniqueName("Calls"),
	);
	const store = new TableCallStore(table);
	beforeAll(() => table.createTable());
	afterAll(() => table.deleteTable());

	it("creates, gets, finds by control ID and lists active calls", async () => {
		const ringing = call({ from: "+31201234567" });
		const missed = call({ status: "missed", missedReason: "timeout" });
		await store.create(ringing);
		await store.create(missed);
		await expect(store.create(ringing)).rejects.toBeInstanceOf(StoreConflict);

		expect((await store.get(ringing.callId))?.value).toEqual(ringing);
		expect(await store.get(newCallId(NOW))).toBeUndefined();
		expect(await store.get("not-a-call-id")).toBeUndefined();
		expect((await store.findByControlId(ringing.callControlId))?.value.callId).toBe(ringing.callId);
		expect(await store.findByControlId("v3:o'brien")).toBeUndefined();
		const active = (await store.active()).map((v) => v.value.callId);
		expect(active).toContain(ringing.callId);
		expect(active).not.toContain(missed.callId);
	});

	it("updates only with the current ETag", async () => {
		const c = call();
		const etag = await store.create(c);
		const next = await store.update({ ...c, status: "accepting" }, etag);
		expect(next).not.toBe(etag);
		await expect(store.update({ ...c, status: "missed" }, etag)).rejects.toBeInstanceOf(
			StoreConflict,
		);
		await expect(store.update(call(), etag)).rejects.toBeInstanceOf(StoreConflict);
	});

	it("gives exactly one winner when two replicas accept at once", async () => {
		// A table of its own: the other tests leave ringing calls, which would make this one busy.
		const raceTable = tableClient(
			{ kind: "connection-string", connectionString: AZURITE },
			uniqueName("Race"),
		);
		await raceTable.createTable();
		const clock = new FakeClock(new Date());
		const a = new CallMachine({ store: new TableCallStore(raceTable), clock });
		const b = new CallMachine({ store: new TableCallStore(raceTable), clock });
		const t = await a.incoming({ callControlId: `v3:race-${Math.random()}` });
		const callId = t?.call.callId ?? "";
		const results = await Promise.allSettled([
			a.accept(callId, { via: "home-assistant" }),
			b.accept(callId, { via: "pixel" }),
		]);
		a.stop();
		b.stop();
		await raceTable.deleteTable();
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect(lost.reason).toBeInstanceOf(AlreadyAccepted);
	});

	it("prunes days before the cutoff", async () => {
		const old = call({ callId: "20200101-aaaaaaaaaaaa" });
		await store.create(old);
		expect(await store.prune(new Date("2021-01-01T00:00:00Z"))).toBe(1);
		expect(await store.get(old.callId)).toBeUndefined();
	});

	it("passes on errors that aren't conflicts", async () => {
		const missing = new TableCallStore(
			tableClient({ kind: "connection-string", connectionString: AZURITE }, uniqueName("Nope")),
		);
		await expect(missing.create(call())).rejects.toThrow();
		await expect(missing.active()).rejects.toThrow();
	});
});

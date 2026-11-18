import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Call } from "../../src/core/calls.ts";
import { eventFor, phoneEvent } from "../../src/core/events.ts";

const at = new Date("2026-11-18T09:00:06Z");
const call: Call = {
	callId: "20261118-3f9a1c2b7d4e",
	callControlId: "v3:x",
	from: "+31201234567",
	to: "+31103024128",
	status: "ringing",
	createdAt: new Date("2026-11-18T09:00:00Z"),
	updatedAt: at,
	acceptBy: new Date("2026-11-18T09:00:15Z"),
};

describe("the event contract", () => {
	it("builds a valid event of every type from a call", () => {
		const events = [
			eventFor.ringing(call, at),
			eventFor.accepted({ ...call, acceptedBy: { via: "pixel", by: "discord:1" } }, at),
			eventFor.accepted({ ...call, acceptedBy: { via: "home-assistant" } }, at),
			eventFor.missed({ ...call, missedReason: "caller_hung_up" }, at),
			eventFor.busy(call, at, "20261118-000000000000"),
			eventFor.ended({ ...call, endedReason: "caller_hung_up" }, at),
		];
		for (const event of events) expect(phoneEvent.parse(event)).toEqual(event);
		expect(events[0]).toEqual({
			version: 1,
			type: "ringing",
			callId: call.callId,
			occurredAt: "2026-11-18T09:00:06.000Z",
			from: "+31201234567",
			to: "+31103024128",
			acceptBy: "2026-11-18T09:00:15.000Z",
		});
		expect(events[2]).not.toHaveProperty("by");
	});

	it("fills defaults and leaves out unknown numbers", () => {
		const bare: Call = { ...call };
		delete bare.from;
		delete bare.to;
		expect(eventFor.ringing(bare, at)).not.toHaveProperty("from");
		expect(eventFor.accepted(bare, at)).toMatchObject({ via: "unknown" });
		expect(eventFor.missed(bare, at)).toMatchObject({ reason: "timeout" });
		expect(eventFor.ended(bare, at)).toMatchObject({ reason: "playback_finished" });
	});

	it("rejects what isn't in the contract", () => {
		const ok = eventFor.ringing(call, at);
		expect(phoneEvent.safeParse({ ...ok, version: 2 }).success).toBe(false);
		expect(phoneEvent.safeParse({ ...ok, extra: 1 }).success).toBe(false);
		expect(phoneEvent.safeParse({ ...ok, callId: "nope" }).success).toBe(false);
		expect(phoneEvent.safeParse({ ...ok, type: "rejected" }).success).toBe(false);
	});

	it("matches every example in docs/events.md, one per type", () => {
		const doc = readFileSync("docs/events.md", "utf8");
		const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) =>
			JSON.parse(m[1] ?? ""),
		);
		const types = examples.map((e) => phoneEvent.parse(e).type);
		expect(types.sort()).toEqual(["accepted", "busy", "ended", "missed", "ringing"]);
	});
});

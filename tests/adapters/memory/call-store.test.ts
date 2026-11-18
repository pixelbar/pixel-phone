import { describe, expect, it } from "vitest";
import { MemoryCallStore } from "../../../src/adapters/memory/call-store.ts";
import { type Call, newCallId } from "../../../src/core/calls.ts";
import { StoreConflict } from "../../../src/core/errors.ts";

const now = new Date("2026-11-18T09:00:00Z");
const call = (over: Partial<Call> = {}): Call => ({
	callId: newCallId(now),
	callControlId: "v3:x",
	status: "ringing",
	createdAt: now,
	updatedAt: now,
	acceptBy: now,
	...over,
});

describe("MemoryCallStore", () => {
	it("behaves like the table: conflicts on create and stale updates, copies on read", async () => {
		const store = new MemoryCallStore();
		const c = call();
		const etag = await store.create(c);
		await expect(store.create(c)).rejects.toBeInstanceOf(StoreConflict);
		const read = await store.get(c.callId);
		if (read) read.value.status = "missed";
		expect((await store.get(c.callId))?.value.status).toBe("ringing");
		await store.update({ ...c, status: "accepting" }, etag);
		await expect(store.update(c, etag)).rejects.toBeInstanceOf(StoreConflict);
		await expect(store.update(call(), "1")).rejects.toBeInstanceOf(StoreConflict);
		expect(await store.findByControlId("v3:none")).toBeUndefined();
		expect(await store.get("nope")).toBeUndefined();
		const later = call({ createdAt: new Date(now.getTime() + 1) });
		await store.create(later);
		expect(store.all().map((x) => x.callId)).toEqual([c.callId, later.callId]);
	});
});

import { describe, expect, it } from "vitest";
import { MemorySeenEvents } from "../../../src/adapters/memory/seen-events.ts";

describe("MemorySeenEvents", () => {
	it("says first seen once per ID, and forgets IDs older than a day", async () => {
		const seen = new MemorySeenEvents();
		const t0 = new Date("2026-11-18T09:00:00Z");
		expect(await seen.firstSeen("a", t0)).toBe(true);
		expect(await seen.firstSeen("a", t0)).toBe(false);
		await seen.firstSeen("b", new Date(t0.getTime() + 25 * 3600_000));
		expect(await seen.firstSeen("a", new Date(t0.getTime() + 25 * 3600_000))).toBe(true);
	});
});

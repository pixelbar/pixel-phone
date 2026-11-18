import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tableClient } from "../../../src/adapters/storage/clients.ts";
import { safeRowKey, TableSeenEvents } from "../../../src/adapters/storage/seen-events.ts";
import { AZURITE, azuriteUp, uniqueName } from "../../helpers/azurite.ts";

describe.skipIf(!azuriteUp)("TableSeenEvents (Azurite)", () => {
	const table = tableClient(
		{ kind: "connection-string", connectionString: AZURITE },
		uniqueName("WebhookEvents"),
	);
	const seen = new TableSeenEvents(table);
	beforeAll(() => table.createTable());
	afterAll(() => table.deleteTable());

	it("records an event ID once", async () => {
		const at = new Date("2026-11-18T09:00:00Z");
		expect(await seen.firstSeen("evt-1", at)).toBe(true);
		expect(await seen.firstSeen("evt-1", at)).toBe(false);
		expect(await seen.firstSeen("evt-2", at)).toBe(true);
	});

	it("catches a redelivery whose first try was on the previous day, keyed by occurredAt", async () => {
		const occurredAt = new Date("2026-11-18T23:59:59Z");
		expect(await seen.firstSeen("evt-midnight", occurredAt)).toBe(true);
		// The retry arrives after midnight, but carries the same occurredAt.
		expect(await seen.firstSeen("evt-midnight", occurredAt)).toBe(false);
	});

	it("is safe with characters a row key can't hold", async () => {
		expect(await seen.firstSeen("a/b#c?d", new Date())).toBe(true);
		expect(safeRowKey("a/b\\c#d?e\u0001")).toBe("a_b_c_d_e_");
	});

	it("prunes days before the cutoff", async () => {
		await seen.firstSeen("old", new Date("2026-11-10T09:00:00Z"));
		await seen.firstSeen("new", new Date("2026-11-18T09:00:00Z"));
		expect(await seen.prune(new Date("2026-11-16T00:00:00Z"))).toBe(1);
		expect(await seen.firstSeen("old", new Date("2026-11-10T09:00:00Z"))).toBe(true);
		expect(await seen.firstSeen("new", new Date("2026-11-18T09:00:00Z"))).toBe(false);
	});

	it("passes on errors that aren't a conflict", async () => {
		const missing = new TableSeenEvents(
			tableClient({ kind: "connection-string", connectionString: AZURITE }, uniqueName("Nope")),
		);
		await expect(missing.firstSeen("x", new Date())).rejects.toThrow();
	});
});

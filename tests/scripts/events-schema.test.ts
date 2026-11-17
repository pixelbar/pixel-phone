import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventsSchema, SCHEMA_FILE } from "../../scripts/events-schema.ts";

describe("docs/events.schema.json", () => {
	it("is up to date with src/core/events.ts (run `just events-schema`)", () => {
		expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(eventsSchema());
	});
});

import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/observability/logger.ts";
import { createReporter } from "../../src/observability/report.ts";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sentry/node")>()),
	captureException: capture,
}));

describe("createReporter", () => {
	it("logs an error line with the area and sends the error to Sentry", () => {
		const lines: Record<string, unknown>[] = [];
		const stream = new Writable({
			write(chunk, _e, done) {
				lines.push(JSON.parse(String(chunk)));
				done();
			},
		});
		const report = createReporter(
			createLogger({ env: "local", logLevel: "info", version: "t" }, stream),
		);
		report("home-assistant", new Error("timeout"), { callId: "c1" });
		expect(lines[0]).toMatchObject({
			level: 50,
			event: "home-assistant.failed",
			area: "home-assistant",
			callId: "c1",
		});
		expect(capture).toHaveBeenCalledOnce();
	});
});

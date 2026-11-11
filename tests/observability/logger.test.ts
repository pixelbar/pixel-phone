import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/observability/logger.ts";

function capture() {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			lines.push(String(chunk));
			done();
		},
	});
	return { lines, logger: createLogger({ env: "dev", logLevel: "info", version: "v1" }, stream) };
}

describe("createLogger", () => {
	it("writes JSON with the service, env and version", () => {
		const { lines, logger } = capture();
		logger.info({ event: "x" }, "hello");
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			service: "pixel-phone",
			env: "dev",
			version: "v1",
			event: "x",
			msg: "hello",
		});
	});

	it("redacts secret fields and headers, and masks token shapes anywhere", () => {
		const { lines, logger } = capture();
		logger.info(
			{
				token: "t",
				apiKey: "k",
				req: { headers: { authorization: "Bearer x", "telnyx-signature-ed25519": "sig" } },
			},
			`leaked KEY${"0A".repeat(12)}_${"y".repeat(20)}`,
		);
		const line = JSON.parse(lines[0] ?? "");
		expect(line.token).toBe("[redacted]");
		expect(line.apiKey).toBe("[redacted]");
		expect(line.req.headers.authorization).toBe("[redacted]");
		expect(line.req.headers["telnyx-signature-ed25519"]).toBe("[redacted]");
		expect(line.msg).toBe("leaked [redacted-telnyx-key]");
	});

	it("can be created without a destination", () => {
		expect(createLogger({ env: "local", logLevel: "warn", version: "v" }).level).toBe("warn");
	});
});

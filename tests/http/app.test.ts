import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BODY_LIMIT, buildApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";

function logged() {
	const lines: Record<string, unknown>[] = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			lines.push(JSON.parse(String(chunk)));
			done();
		},
	});
	return {
		lines,
		logger: createLogger({ env: "local", logLevel: "info", version: "test" }, stream),
	};
}

const apps: ReturnType<typeof buildApp>[] = [];
function app(gitSha?: string) {
	const { lines, logger } = logged();
	const instance = buildApp({
		config: { env: "dev", version: "1.2.3", ...(gitSha ? { gitSha } : {}) },
		logger,
	});
	apps.push(instance);
	return { instance, lines };
}
afterEach(async () => {
	await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("the HTTP app", () => {
	it("answers the health probe without logging it", async () => {
		const { instance, lines } = app();
		const res = await instance.inject({ method: "GET", url: "/healthz" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "ok" });
		expect(lines.filter((l) => l.event === "http.request")).toEqual([]);
	});

	it("says which version is running", async () => {
		expect((await app("abc123").instance.inject({ url: "/version" })).json()).toEqual({
			service: "pixel-phone",
			env: "dev",
			version: "1.2.3",
			sha: "abc123",
		});
		expect((await app().instance.inject({ url: "/version" })).json()).not.toHaveProperty("sha");
	});

	it("answers 503 on the webhook when Telnyx isn't configured", async () => {
		const res = await app().instance.inject({
			method: "POST",
			url: "/webhooks/telnyx",
			payload: { data: {} },
		});
		expect(res.statusCode).toBe(503);
	});

	it("takes the client address from the ingress's hop only, not a spoofed one", async () => {
		const { instance } = app();
		instance.get("/ip", async (request) => ({ ip: request.ip }));
		const res = await instance.inject({
			url: "/ip",
			headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
			remoteAddress: "10.0.0.1",
		});
		expect(res.json()).toEqual({ ip: "203.0.113.7" });
	});

	it("refuses oversized bodies and unknown routes", async () => {
		const { instance, lines } = app();
		const big = await instance.inject({
			method: "POST",
			url: "/webhooks/telnyx",
			headers: { "content-type": "application/json" },
			payload: `{"data":{"x":"${"a".repeat(BODY_LIMIT)}"}}`,
		});
		expect(big.statusCode).toBe(413);
		expect((await instance.inject({ url: "/nope" })).statusCode).toBe(404);
		expect(lines.find((l) => l.status === 404)).toMatchObject({ path: "unmatched" });
	});
});

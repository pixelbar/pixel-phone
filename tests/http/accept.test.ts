import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MemoryCallStore } from "../../src/adapters/memory/call-store.ts";
import { CallMachine } from "../../src/core/call-machine.ts";
import { ApiKeys } from "../../src/http/api-keys.ts";
import { buildApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakeClock } from "../../src/testing/fake-clock.ts";

const HA_KEY = "ha-test-key-0123456789abcdefghijklmnop";
const PIXEL_KEY = "pixel-test-key-0123456789abcdefghijklm";
const keys = new ApiKeys([
	{ id: "home-assistant", key: HA_KEY },
	{ id: "pixel", key: PIXEL_KEY },
]);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function setup(options: { keys?: ApiKeys | undefined; perMinute?: number } = {}) {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _e, done) {
			lines.push(String(chunk));
			done();
		},
	});
	const clock = new FakeClock();
	const machine = new CallMachine({ store: new MemoryCallStore(), clock });
	const app = buildApp({
		config: { env: "local", version: "test" },
		logger: createLogger({ env: "local", logLevel: "info", version: "t" }, stream),
		accept: {
			keys: "keys" in options ? options.keys : keys,
			accept: (target, acceptor) => machine.accept(target, acceptor),
			...(options.perMinute ? { perMinute: options.perMinute } : {}),
		},
	});
	cleanups.push(
		() => app.close(),
		() => machine.stop(),
	);
	const post = (
		url: string,
		key?: string,
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		app.inject({
			method: "POST",
			url,
			headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
			...(payload === undefined ? {} : { payload: payload as object }),
		});
	const ring = async (id = "v3:door") => {
		const t = await machine.incoming({ callControlId: id, from: "+31201234567" });
		return t?.call.callId ?? "";
	};
	const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { app, machine, clock, post, ring, lines, logs };
}

const CURRENT = "/api/v1/calls/current/accept";
const byId = (id: string) => `/api/v1/calls/${id}/accept`;

describe("the accept API", () => {
	it("202: Home Assistant accepts the current call; via is the key's id", async () => {
		const s = setup();
		const callId = await s.ring();
		const res = await s.post(CURRENT, HA_KEY);
		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ callId });
		expect(s.logs().find((l) => l.event === "accept.accepted")).toMatchObject({
			via: "home-assistant",
			callId,
		});
	});

	it("202: Pixel accepts by call ID, recording who", async () => {
		const s = setup();
		const callId = await s.ring();
		const res = await s.post(byId(callId), PIXEL_KEY, { by: "discord:42" });
		expect(res.statusCode).toBe(202);
		expect(s.logs().find((l) => l.event === "accept.accepted")).toMatchObject({
			via: "pixel",
			by: "discord:42",
		});
	});

	it("accepts an empty body with a JSON content type", async () => {
		const s = setup();
		await s.ring();
		const res = await s.app.inject({
			method: "POST",
			url: CURRENT,
			headers: { authorization: `Bearer ${HA_KEY}`, "content-type": "application/json" },
			payload: "",
		});
		expect(res.statusCode).toBe(202);
	});

	it("409: the loser learns who won", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.post(byId(callId), PIXEL_KEY, { by: "discord:42" });
		const res = await s.post(CURRENT, HA_KEY);
		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({ callId, via: "pixel", by: "discord:42" });
		const again = await s.post(byId(callId), HA_KEY);
		expect(again.statusCode).toBe(409);
		expect(again.json()).not.toHaveProperty("by", undefined);
	});

	it("404: nothing is ringing, or no such call", async () => {
		const s = setup();
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(404);
		expect((await s.post(byId("20261118-000000000000"), PIXEL_KEY)).statusCode).toBe(404);
		expect((await s.post(byId("x".repeat(80)), PIXEL_KEY)).statusCode).toBe(404);
	});

	it("410: too late", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.clock.advance(15_000);
		const res = await s.post(byId(callId), PIXEL_KEY);
		expect(res.statusCode).toBe(410);
		expect(res.json()).toMatchObject({ callId });
	});

	it("401: missing, wrong or malformed key; nothing is accepted", async () => {
		const s = setup();
		await s.ring();
		expect((await s.post(CURRENT)).statusCode).toBe(401);
		expect((await s.post(CURRENT, `${HA_KEY}x`)).statusCode).toBe(401);
		expect(
			(await s.post(CURRENT, undefined, undefined, { authorization: HA_KEY })).statusCode,
		).toBe(401);
		expect((await s.post(CURRENT, "")).statusCode).toBe(401);
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(202);
	});

	it("400: a body that isn't { by }", async () => {
		const s = setup();
		await s.ring();
		expect((await s.post(CURRENT, HA_KEY, { by: 42 })).statusCode).toBe(400);
		expect((await s.post(CURRENT, HA_KEY, { who: "me" })).statusCode).toBe(400);
		const notJson = await s.app.inject({
			method: "POST",
			url: CURRENT,
			headers: { authorization: `Bearer ${HA_KEY}`, "content-type": "application/json" },
			payload: "{nope",
		});
		expect(notJson.statusCode).toBe(400);
	});

	it("429: each key is rate limited on its own", async () => {
		const s = setup({ perMinute: 2 });
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(404);
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(404);
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(429);
		expect((await s.post(CURRENT, PIXEL_KEY)).statusCode).toBe(404);
		expect(s.logs().find((l) => l.event === "accept.rate_limited")).toMatchObject({
			via: "home-assistant",
		});
	});

	it("503 when no keys are configured", async () => {
		const s = setup({ keys: undefined });
		expect((await s.post(CURRENT, HA_KEY)).statusCode).toBe(503);
	});

	it("never logs a key", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.post(CURRENT, `${HA_KEY}x`);
		await s.post(byId(callId), PIXEL_KEY);
		await s.post(CURRENT, HA_KEY);
		const all = s.lines.join("\n");
		expect(all).not.toContain(HA_KEY);
		expect(all).not.toContain(PIXEL_KEY);
		expect(all).toContain("home-assistant");
	});

	it("matches docs/openapi.yaml's paths", async () => {
		const spec = parse(readFileSync("docs/openapi.yaml", "utf8")) as {
			paths: Record<string, { post: { responses: Record<string, unknown> } }>;
		};
		expect(Object.keys(spec.paths).sort()).toEqual([
			"/api/v1/calls/current/accept",
			"/api/v1/calls/{callId}/accept",
		]);
		for (const path of Object.values(spec.paths)) {
			expect(Object.keys(path.post.responses).sort()).toEqual(
				["202", "400", "401", "404", "409", "410", "429", "503"].sort(),
			);
		}
	});
});

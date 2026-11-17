import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySeenEvents } from "../../src/adapters/memory/seen-events.ts";
import { telnyxPublicKey } from "../../src/adapters/telnyx/webhook.ts";
import type { SeenEvents, TelephonyEvent } from "../../src/core/telephony-events.ts";
import { buildApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { FakeClock, flush } from "../../src/testing/fake-clock.ts";
import { createTestSigner, telnyxWebhookBody } from "../../src/testing/telnyx-signing.ts";

const signer = createTestSigner();
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((a) => a.close()));
});

function setup(options: { seen?: SeenEvents; failHandler?: boolean } = {}) {
	const lines: Record<string, unknown>[] = [];
	const stream = new Writable({
		write(chunk, _encoding, done) {
			lines.push(JSON.parse(String(chunk)));
			done();
		},
	});
	const logger = createLogger({ env: "local", logLevel: "debug", version: "test" }, stream);
	const clock = new FakeClock(new Date());
	const handled: TelephonyEvent[] = [];
	const report = vi.fn();
	const instance = buildApp({
		config: { env: "local", version: "test" },
		logger,
		telnyxWebhook: {
			publicKey: telnyxPublicKey(signer.publicKeyBase64),
			seen: options.seen ?? new MemorySeenEvents(),
			handler: {
				async handle(event) {
					if (options.failHandler) throw new Error("flow broke");
					handled.push(event);
				},
			},
			clock,
			report,
		},
	});
	apps.push(instance);
	const post = (body: string, headers = signer.headers(body)) =>
		instance.inject({ method: "POST", url: "/webhooks/telnyx", headers, payload: body });
	return { instance, lines, handled, report, post };
}

const initiated = (id?: string) =>
	telnyxWebhookBody(
		"call.initiated",
		{ call_control_id: "v3:abc", from: "+31201234567", to: "+31103024128", direction: "incoming" },
		id ? { id } : {},
	);

describe("POST /webhooks/telnyx", () => {
	it("verifies, acknowledges and hands the event on, logging it", async () => {
		const { post, handled, lines } = setup();
		const res = await post(initiated("evt-1"));
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ received: true });
		await flush();
		expect(handled).toHaveLength(1);
		expect(handled[0]).toMatchObject({ id: "evt-1", type: "call.initiated", from: "+31201234567" });
		expect(lines.find((l) => l.event === "telnyx.webhook")).toMatchObject({
			eventId: "evt-1",
			eventType: "call.initiated",
			from: "+31201234567",
		});
	});

	it("rejects a bad signature with 401 and a warning, without reporting it", async () => {
		const { post, handled, lines, report } = setup();
		const body = initiated();
		const res = await post(body.replace("v3:abc", "v3:evil"), signer.headers(body));
		expect(res.statusCode).toBe(401);
		const rejected = lines.find((l) => l.event === "telnyx.webhook_rejected");
		expect(rejected).toMatchObject({ level: 40, reason: "bad_signature" });
		expect(JSON.stringify(lines)).not.toContain(signer.headers(body)["telnyx-signature-ed25519"]);
		await flush();
		expect(handled).toEqual([]);
		expect(report).not.toHaveBeenCalled();
	});

	it("rejects missing headers and stale timestamps", async () => {
		const { post } = setup();
		const body = initiated();
		expect((await post(body, { "content-type": "application/json" })).statusCode).toBe(401);
		const stale = signer.headers(body, new Date(Date.now() - 10 * 60_000));
		expect((await post(body, stale)).statusCode).toBe(401);
	});

	it("acknowledges a duplicate event ID without handling it again", async () => {
		const { post, handled, lines } = setup();
		expect((await post(initiated("evt-dup"))).statusCode).toBe(200);
		expect((await post(initiated("evt-dup"))).statusCode).toBe(200);
		await flush();
		expect(handled).toHaveLength(1);
		expect(lines.some((l) => l.event === "telnyx.webhook_duplicate")).toBe(true);
	});

	it("handles the event anyway when de-duplication storage fails, and reports it", async () => {
		const { post, handled, report } = setup({
			seen: { firstSeen: () => Promise.reject(new Error("table down")) },
		});
		expect((await post(initiated())).statusCode).toBe(200);
		await flush();
		expect(handled).toHaveLength(1);
		expect(report).toHaveBeenCalledWith("storage", expect.any(Error), expect.any(Object));
	});

	it("acknowledges events it doesn't act on, and signed junk", async () => {
		const { post, handled, lines } = setup();
		expect(
			(await post(telnyxWebhookBody("call.bridged", { call_control_id: "x" }))).statusCode,
		).toBe(200);
		expect((await post('{"data":{}}')).statusCode).toBe(200);
		await flush();
		expect(handled).toEqual([]);
		expect(lines.find((l) => l.event === "telnyx.webhook_ignored")).toMatchObject({
			level: 20,
			eventType: "call.bridged",
		});
		expect(lines.some((l) => l.event === "telnyx.webhook_unparsed")).toBe(true);
	});

	it("reports a call flow failure after acknowledging", async () => {
		const { post, report } = setup({ failHandler: true });
		expect((await post(initiated())).statusCode).toBe(200);
		await flush();
		expect(report).toHaveBeenCalledWith(
			"call-flow",
			expect.any(Error),
			expect.objectContaining({ eventType: "call.initiated" }),
		);
	});

	it("answers 503 when the public key is missing", async () => {
		const instance = buildApp({
			config: { env: "local", version: "test" },
			logger: createLogger({ env: "local", logLevel: "fatal", version: "t" }),
			telnyxWebhook: {
				publicKey: undefined,
				seen: new MemorySeenEvents(),
				handler: { handle: async () => {} },
				clock: new FakeClock(),
				report: vi.fn(),
			},
		});
		apps.push(instance);
		const body = initiated();
		const res = await instance.inject({
			method: "POST",
			url: "/webhooks/telnyx",
			headers: signer.headers(body),
			payload: body,
		});
		expect(res.statusCode).toBe(503);
	});
});

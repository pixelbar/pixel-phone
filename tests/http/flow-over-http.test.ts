/**
 * The whole app over HTTP, with the real routes, call flow and Telnyx adapter, and fakes
 * at the edges: signed webhooks in, the accept API, Call Control commands out to the fake
 * Telnyx API, Home Assistant and the queue faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantRinger } from "../../src/adapters/home-assistant/ringer.ts";
import { MemoryCallStore } from "../../src/adapters/memory/call-store.ts";
import { MemorySeenEvents } from "../../src/adapters/memory/seen-events.ts";
import { decodeClientState } from "../../src/adapters/telnyx/client-state.ts";
import { TelnyxTelephony } from "../../src/adapters/telnyx/telephony.ts";
import { telnyxPublicKey } from "../../src/adapters/telnyx/webhook.ts";
import { CallFlow } from "../../src/core/call-flow.ts";
import { systemClock } from "../../src/core/clock.ts";
import { ApiKeys } from "../../src/http/api-keys.ts";
import { buildApp } from "../../src/http/app.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { flush } from "../../src/testing/fake-clock.ts";
import { startFakeHomeAssistant } from "../../src/testing/fake-home-assistant.ts";
import { FakeMedia } from "../../src/testing/fake-media.ts";
import { FakePublisher } from "../../src/testing/fake-publisher.ts";
import { startFakeTelnyxApi } from "../../src/testing/fake-telnyx-api.ts";
import { createTestSigner, telnyxWebhookBody } from "../../src/testing/telnyx-signing.ts";

const KEY = "home-assistant-key-0123456789abcdefghij";
const ENTITY = "input_boolean.pixel_phone_ringing_dev";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

describe("a doorbell call over HTTP", () => {
	it("rings, is accepted by the button, plays the recording and hangs up", async () => {
		const signer = createTestSigner();
		const telnyx = await startFakeTelnyxApi();
		const ha = await startFakeHomeAssistant();
		cleanups.push(
			() => telnyx.close(),
			() => ha.close(),
		);
		const publisher = new FakePublisher();
		const report = vi.fn();
		const flow = new CallFlow({
			store: new MemoryCallStore(),
			clock: systemClock,
			telephony: new TelnyxTelephony({ apiKey: telnyx.apiKey, baseUrl: telnyx.url }),
			ringer: new HomeAssistantRinger({ url: ha.url, token: ha.token, entityId: ENTITY }),
			publisher,
			media: new FakeMedia(),
			recording: "accepted.mp3",
			observer: { log: () => {}, fail: report },
		});
		cleanups.push(() => flow.stop());
		const app = buildApp({
			config: { env: "local", version: "test" },
			logger: createLogger({ env: "local", logLevel: "fatal", version: "t" }),
			telnyxWebhook: {
				publicKey: telnyxPublicKey(signer.publicKeyBase64),
				seen: new MemorySeenEvents(),
				handler: flow,
				clock: systemClock,
				report,
			},
			accept: {
				keys: new ApiKeys([{ id: "home-assistant", key: KEY }]),
				accept: (t, a) => flow.accept(t, a),
			},
		});
		cleanups.push(() => app.close());
		const webhook = async (type: string, payload: Record<string, unknown>) => {
			const body = telnyxWebhookBody(type, { call_control_id: "v3:door", ...payload });
			const res = await app.inject({
				method: "POST",
				url: "/webhooks/telnyx",
				headers: signer.headers(body),
				payload: body,
			});
			expect(res.statusCode).toBe(200);
			await flush();
			await flow.idle();
		};

		await webhook("call.initiated", {
			direction: "incoming",
			from: "+31201234567",
			to: "+31103024128",
		});
		expect(ha.states.get(ENTITY)).toBe("on");
		expect(telnyx.requests).toEqual([]);

		const accepted = await app.inject({
			method: "POST",
			url: "/api/v1/calls/current/accept",
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(accepted.statusCode).toBe(202);
		const { callId } = accepted.json() as { callId: string };
		await flush();
		await flow.idle();
		expect(telnyx.requests.map((r) => r.path)).toEqual([
			"/v2/calls/v3%3Adoor/actions/answer",
			"/v2/calls/v3%3Adoor/actions/playback_start",
		]);
		expect(ha.states.get(ENTITY)).toBe("off");

		const clientState =
			(telnyx.requests[1]?.body as { client_state?: string } | undefined)?.client_state ?? "";
		expect(decodeClientState(clientState)).toBe(callId);
		await webhook("call.answered", { client_state: clientState });
		await webhook("call.playback.ended", { client_state: clientState });
		expect(telnyx.requests.at(-1)?.path).toBe("/v2/calls/v3%3Adoor/actions/hangup");
		await webhook("call.hangup", { client_state: clientState, hangup_cause: "normal_clearing" });

		expect(publisher.types()).toEqual(["ringing", "accepted", "ended"]);
		expect(report).not.toHaveBeenCalled();
	});
});

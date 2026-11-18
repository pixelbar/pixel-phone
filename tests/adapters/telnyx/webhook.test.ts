import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeClientState, encodeClientState } from "../../../src/adapters/telnyx/client-state.ts";
import {
	parseTelnyxWebhook,
	telnyxPublicKey,
	verifyTelnyxSignature,
} from "../../../src/adapters/telnyx/webhook.ts";
import { createTestSigner, telnyxWebhookBody } from "../../../src/testing/telnyx-signing.ts";

const signer = createTestSigner();
const key = telnyxPublicKey(signer.publicKeyBase64);
const NOW = new Date("2026-11-18T09:00:00Z");

function check(body: string, headers: Record<string, string | undefined>, now = NOW) {
	return verifyTelnyxSignature({
		rawBody: Buffer.from(body),
		signature: headers["telnyx-signature-ed25519"],
		timestamp: headers["telnyx-timestamp"],
		publicKey: key,
		now,
	});
}

describe("verifyTelnyxSignature", () => {
	const body = telnyxWebhookBody("call.initiated", { call_control_id: "v3:abc" });

	it("accepts a valid signature over the raw body", () => {
		expect(check(body, signer.headers(body, NOW))).toEqual({ ok: true });
	});

	it("rejects a tampered body", () => {
		const headers = signer.headers(body, NOW);
		expect(check(body.replace("v3:abc", "v3:xyz"), headers)).toEqual({
			ok: false,
			reason: "bad_signature",
		});
	});

	it("rejects a timestamp outside five minutes, either way", () => {
		const old = signer.headers(body, new Date(NOW.getTime() - 301_000));
		expect(check(body, old).ok).toBe(false);
		expect(check(body, old)).toMatchObject({ reason: "stale_timestamp" });
		const future = signer.headers(body, new Date(NOW.getTime() + 301_000));
		expect(check(body, future)).toMatchObject({ reason: "stale_timestamp" });
		const recent = signer.headers(body, new Date(NOW.getTime() - 299_000));
		expect(check(body, recent).ok).toBe(true);
	});

	it("rejects missing or malformed headers", () => {
		const headers = signer.headers(body, NOW);
		expect(check(body, { ...headers, "telnyx-signature-ed25519": undefined })).toMatchObject({
			reason: "missing_headers",
		});
		expect(check(body, { ...headers, "telnyx-timestamp": undefined })).toMatchObject({
			reason: "missing_headers",
		});
		expect(check(body, { ...headers, "telnyx-timestamp": "soon" })).toMatchObject({
			reason: "missing_headers",
		});
	});

	it("rejects a signature from another key, and garbage", () => {
		const other = createTestSigner();
		expect(check(body, other.headers(body, NOW))).toMatchObject({ reason: "bad_signature" });
		const headers = { ...signer.headers(body, NOW), "telnyx-signature-ed25519": "!!" };
		expect(check(body, headers)).toMatchObject({ reason: "bad_signature" });
	});
});

describe("telnyxPublicKey", () => {
	it("reads raw base64, base64 SPKI and PEM", () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const spki = publicKey.export({ format: "der", type: "spki" });
		const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
		for (const form of [spki.subarray(12).toString("base64"), spki.toString("base64"), pem]) {
			expect(telnyxPublicKey(form).asymmetricKeyType).toBe("ed25519");
		}
	});
});

describe("parseTelnyxWebhook", () => {
	it("maps the v2 envelope to a TelephonyEvent", () => {
		const occurredAt = new Date("2026-11-18T09:00:01Z");
		const body = telnyxWebhookBody(
			"call.hangup",
			{
				call_control_id: "v3:abc",
				call_leg_id: "leg",
				call_session_id: "sess",
				client_state: encodeClientState("call-1"),
				from: "+31201234567",
				to: "+31103024128",
				direction: "incoming",
				state: "hangup",
				hangup_cause: "normal_clearing",
				extra: "ignored",
			},
			{ id: "evt-1", occurredAt },
		);
		expect(parseTelnyxWebhook(Buffer.from(body))).toEqual({
			kind: "event",
			event: {
				id: "evt-1",
				type: "call.hangup",
				occurredAt,
				callControlId: "v3:abc",
				callLegId: "leg",
				callSessionId: "sess",
				callId: "call-1",
				from: "+31201234567",
				to: "+31103024128",
				direction: "incoming",
				hangupCause: "normal_clearing",
			},
		});
	});

	it("leaves out what Telnyx didn't send", () => {
		const parsed = parseTelnyxWebhook(
			Buffer.from(telnyxWebhookBody("call.initiated", { call_control_id: "v3:x", direction: "?" })),
		);
		expect(parsed.kind === "event" && Object.keys(parsed.event).sort()).toEqual([
			"callControlId",
			"id",
			"occurredAt",
			"type",
		]);
	});

	it("ignores event types we don't act on", () => {
		const body = telnyxWebhookBody("call.bridged", {}, { id: "evt-2" });
		expect(parseTelnyxWebhook(Buffer.from(body))).toEqual({
			kind: "ignored",
			id: "evt-2",
			eventType: "call.bridged",
		});
	});

	it("calls invalid what isn't a v2 call event", () => {
		expect(parseTelnyxWebhook(Buffer.from("nope"))).toMatchObject({ kind: "invalid" });
		expect(parseTelnyxWebhook(Buffer.from('{"data":{}}'))).toMatchObject({ kind: "invalid" });
		expect(parseTelnyxWebhook(Buffer.from(telnyxWebhookBody("call.initiated", {})))).toMatchObject({
			kind: "invalid",
			reason: "data.payload.call_control_id",
		});
		const badDate = JSON.stringify({
			data: {
				id: "x",
				event_type: "call.hangup",
				occurred_at: "yesterday",
				payload: { call_control_id: "c" },
			},
		});
		expect(parseTelnyxWebhook(Buffer.from(badDate))).toMatchObject({ reason: "data.occurred_at" });
	});
});

describe("client state", () => {
	it("round-trips our call ID and ignores anything else", () => {
		expect(decodeClientState(encodeClientState("call-1"))).toBe("call-1");
		expect(decodeClientState(undefined)).toBeUndefined();
		expect(decodeClientState(Buffer.from('{"other":1}').toString("base64"))).toBeUndefined();
		expect(decodeClientState("%%%")).toBeUndefined();
	});
});

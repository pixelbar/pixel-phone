/**
 * Telnyx webhooks: signature verification and parsing into the core's TelephonyEvent.
 *
 * Telnyx signs `${telnyx-timestamp}|${raw body}` with the account's Ed25519 key and sends
 * the base64 signature in `telnyx-signature-ed25519`. We check it against the raw bytes
 * (re-serialised JSON would not match) and refuse timestamps more than five minutes off,
 * so a captured request can't be replayed later.
 */
import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { z } from "zod";
import {
	TELEPHONY_EVENT_TYPES,
	type TelephonyEvent,
	type TelephonyEventType,
} from "../../core/telephony-events.ts";
import { decodeClientState } from "./client-state.ts";

export const SIGNATURE_HEADER = "telnyx-signature-ed25519";
export const TIMESTAMP_HEADER = "telnyx-timestamp";
export const REPLAY_WINDOW_SECONDS = 5 * 60;

/** DER prefix that turns a raw 32-byte Ed25519 public key into SPKI. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Reads the account public key as the portal shows it: base64 of the raw 32 bytes. A PEM
 * or base64 SPKI key is accepted too.
 */
export function telnyxPublicKey(value: string): KeyObject {
	const trimmed = value.trim();
	if (trimmed.startsWith("-----BEGIN")) return createPublicKey(trimmed);
	const bytes = Buffer.from(trimmed, "base64");
	if (bytes.length === 32) {
		return createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
			format: "der",
			type: "spki",
		});
	}
	return createPublicKey({ key: bytes, format: "der", type: "spki" });
}

export type VerifyFailure = "missing_headers" | "stale_timestamp" | "bad_signature";

export function verifyTelnyxSignature(input: {
	rawBody: Buffer;
	signature: string | undefined;
	timestamp: string | undefined;
	publicKey: KeyObject;
	now: Date;
}): { ok: true } | { ok: false; reason: VerifyFailure } {
	const { rawBody, signature, timestamp, publicKey, now } = input;
	if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) {
		return { ok: false, reason: "missing_headers" };
	}
	const age = Math.abs(now.getTime() / 1000 - Number(timestamp));
	if (age > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" };
	const signed = Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), rawBody]);
	let valid = false;
	try {
		valid = verify(null, signed, publicKey, Buffer.from(signature, "base64"));
	} catch {
		valid = false;
	}
	return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

const optionalText = z.string().nullish();

/** The v2 envelope. Fields we don't use are ignored, not rejected. */
const envelope = z.object({
	data: z.object({
		id: z.string().min(1),
		event_type: z.string().min(1),
		occurred_at: z.string().min(1),
		payload: z
			.object({
				call_control_id: optionalText,
				call_leg_id: optionalText,
				call_session_id: optionalText,
				client_state: optionalText,
				from: optionalText,
				to: optionalText,
				direction: optionalText,
				state: optionalText,
				hangup_cause: optionalText,
			})
			.passthrough()
			.default({}),
	}),
});

export type ParsedWebhook =
	| { kind: "event"; event: TelephonyEvent }
	/** A well-formed event we don't act on (e.g. call.bridged). Logged, then acknowledged. */
	| { kind: "ignored"; id: string; eventType: string }
	| { kind: "invalid"; reason: string };

const known = new Set<string>(TELEPHONY_EVENT_TYPES);

export function parseTelnyxWebhook(rawBody: Buffer): ParsedWebhook {
	let json: unknown;
	try {
		json = JSON.parse(rawBody.toString("utf8"));
	} catch {
		return { kind: "invalid", reason: "not JSON" };
	}
	const result = envelope.safeParse(json);
	if (!result.success) {
		return { kind: "invalid", reason: result.error.issues.map((i) => i.path.join(".")).join(", ") };
	}
	const { id, event_type, occurred_at, payload } = result.data.data;
	if (!known.has(event_type)) return { kind: "ignored", id, eventType: event_type };
	if (!payload.call_control_id) return { kind: "invalid", reason: "data.payload.call_control_id" };
	const occurredAt = new Date(occurred_at);
	if (Number.isNaN(occurredAt.getTime())) return { kind: "invalid", reason: "data.occurred_at" };

	const callId = decodeClientState(payload.client_state ?? undefined);
	const direction =
		payload.direction === "incoming" || payload.direction === "outgoing"
			? payload.direction
			: undefined;
	const event: TelephonyEvent = {
		id,
		type: event_type as TelephonyEventType,
		occurredAt,
		callControlId: payload.call_control_id,
		...(payload.call_leg_id ? { callLegId: payload.call_leg_id } : {}),
		...(payload.call_session_id ? { callSessionId: payload.call_session_id } : {}),
		...(payload.from ? { from: payload.from } : {}),
		...(payload.to ? { to: payload.to } : {}),
		...(direction ? { direction } : {}),
		...(callId ? { callId } : {}),
		...(payload.hangup_cause ? { hangupCause: payload.hangup_cause } : {}),
	};
	return { kind: "event", event };
}

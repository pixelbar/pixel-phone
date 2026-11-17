/**
 * Signs webhooks the way Telnyx does, with a key pair made for the test run. Used by the
 * webhook tests and the local harness (#17), so neither needs the real account key.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

export type TestSigner = {
	/** The public key as the Telnyx portal shows it: base64 of the raw 32 bytes. */
	publicKeyBase64: string;
	privateKey: KeyObject;
	/** Headers for `body`, signed at `at` (default now). */
	headers(body: string, at?: Date): Record<string, string>;
};

export function createTestSigner(): TestSigner {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" });
	const publicKeyBase64 = spki.subarray(spki.length - 32).toString("base64");
	return {
		publicKeyBase64,
		privateKey,
		headers(body, at = new Date()) {
			const timestamp = String(Math.floor(at.getTime() / 1000));
			const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey);
			return {
				"content-type": "application/json",
				"telnyx-timestamp": timestamp,
				"telnyx-signature-ed25519": signature.toString("base64"),
			};
		},
	};
}

let counter = 0;

/** A Telnyx v2 webhook body, as Telnyx would send it. */
export function telnyxWebhookBody(
	eventType: string,
	payload: Record<string, unknown>,
	options: { id?: string; occurredAt?: Date } = {},
): string {
	counter++;
	return JSON.stringify({
		data: {
			record_type: "event",
			id: options.id ?? `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
			event_type: eventType,
			occurred_at: (options.occurredAt ?? new Date()).toISOString(),
			payload,
		},
		meta: { attempt: 1, delivered_to: "http://localhost/webhooks/telnyx" },
	});
}

/**
 * `POST /webhooks/telnyx`: verify, de-duplicate, acknowledge, then hand the event to the
 * call flow. Telnyx waits for our reply before sending the next event for the call, so
 * we answer as soon as the event is safely recorded and handle it afterwards.
 */
import type { KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
	parseTelnyxWebhook,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
	verifyTelnyxSignature,
} from "../adapters/telnyx/webhook.ts";
import type { Clock } from "../core/clock.ts";
import type { SeenEvents, TelephonyEventHandler } from "../core/telephony-events.ts";
import type { Report } from "../observability/report.ts";

export type TelnyxWebhookDeps = {
	/** Undefined when Telnyx isn't configured: the route answers 503. */
	publicKey: KeyObject | undefined;
	seen: SeenEvents;
	handler: TelephonyEventHandler;
	clock: Clock;
	report: Report;
};

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function telnyxWebhookRoutes(app: FastifyInstance, deps: TelnyxWebhookDeps) {
	// The signature covers the exact bytes Telnyx sent, so keep them.
	app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
		done(null, body),
	);

	app.post("/webhooks/telnyx", async (request, reply) => {
		if (deps.publicKey === undefined) {
			request.log.warn({ event: "telnyx.webhook_unconfigured" }, "Telnyx isn't configured");
			return reply.code(503).send({ error: "telnyx is not configured" });
		}
		const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
		const verified = verifyTelnyxSignature({
			rawBody,
			signature: header(request.headers[SIGNATURE_HEADER]),
			timestamp: header(request.headers[TIMESTAMP_HEADER]),
			publicKey: deps.publicKey,
			now: deps.clock.now(),
		});
		if (!verified.ok) {
			// A warning, never a Sentry error: anyone on the internet can send us junk.
			request.log.warn(
				{ event: "telnyx.webhook_rejected", reason: verified.reason },
				"Telnyx webhook rejected",
			);
			return reply.code(401).send({ error: "invalid signature" });
		}

		const parsed = parseTelnyxWebhook(rawBody);
		if (parsed.kind === "invalid") {
			// Signed by Telnyx but not what we expect: acknowledge so it isn't retried forever.
			request.log.warn(
				{ event: "telnyx.webhook_unparsed", reason: parsed.reason },
				"Telnyx webhook not understood",
			);
			return { received: true };
		}
		if (parsed.kind === "ignored") {
			request.log.debug(
				{ event: "telnyx.webhook_ignored", eventId: parsed.id, eventType: parsed.eventType },
				"Telnyx event we don't act on",
			);
			return { received: true };
		}

		const { event } = parsed;
		let first = true;
		try {
			first = await deps.seen.firstSeen(event.id, deps.clock.now());
		} catch (error) {
			// The call flow ignores repeats of what it already did, so handling a possible
			// duplicate is safer than dropping an event.
			deps.report("storage", error, { during: "webhook de-duplication", eventId: event.id });
		}
		const context = {
			eventId: event.id,
			eventType: event.type,
			callControlId: event.callControlId,
			...(event.callId ? { callId: event.callId } : {}),
			...(event.from ? { from: event.from } : {}),
			...(event.to ? { to: event.to } : {}),
		};
		if (!first) {
			request.log.info({ event: "telnyx.webhook_duplicate", ...context }, "duplicate event");
			return { received: true };
		}
		request.log.info({ event: "telnyx.webhook", ...context }, "Telnyx event");

		// After the reply: Telnyx doesn't need to wait for Home Assistant or the queue.
		setImmediate(() => {
			deps.handler.handle(event).catch((error: unknown) => {
				deps.report("call-flow", error, context);
			});
		});
		return { received: true };
	});
}

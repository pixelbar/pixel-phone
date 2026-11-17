/**
 * The accept API: `POST /api/v1/calls/current/accept` (Home Assistant's button, which
 * doesn't know the call ID) and `POST /api/v1/calls/{callId}/accept` (Pixel). Accepting
 * makes pixel-phone answer the call, so it needs a bearer key (`API_KEYS_YAML`).
 * docs/openapi.yaml describes it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Acceptor, Call } from "../core/calls.ts";
import { AcceptTooLate, AlreadyAccepted, NoSuchCall } from "../core/errors.ts";
import type { ApiKeys } from "./api-keys.ts";
import { RateLimiter } from "./rate-limit.ts";

export type AcceptDeps = {
	/** Undefined when `API_KEYS_YAML` isn't set: the routes answer 503. */
	keys: ApiKeys | undefined;
	/** Accepts the call (`"current"` or a call ID). Throws the core's accept errors. */
	accept: (target: string, acceptor: Acceptor) => Promise<Call>;
	/** Requests per key per minute (default 10). */
	perMinute?: number;
	now?: () => number;
};

const body = z
	.strictObject({ by: z.string().trim().min(1).max(100).optional() })
	.optional()
	.nullable();

const params = z.object({ callId: z.string().min(1).max(64) });

export async function acceptRoutes(app: FastifyInstance, deps: AcceptDeps) {
	// The body is optional. Home Assistant's rest_command may send an empty body with a JSON
	// content type, which Fastify would otherwise refuse.
	app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, text, done) => {
		if (typeof text !== "string" || text.trim() === "") return done(null, undefined);
		try {
			done(null, JSON.parse(text));
		} catch {
			done(null, { invalid: true });
		}
	});

	const perKey = new RateLimiter(deps.perMinute ?? 10, 60_000, deps.now);
	// Failed logins per client address, so a scanner can't fill the logs.
	const perAddress = new RateLimiter(30, 60_000, deps.now);

	async function handle(request: FastifyRequest, reply: FastifyReply, target: string) {
		if (!deps.keys) return reply.code(503).send({ error: "the accept API is not configured" });
		const via = deps.keys.identify(request.headers.authorization);
		if (via === undefined) {
			if (perAddress.take(request.ip)) {
				request.log.warn({ event: "accept.unauthorized" }, "accept with a bad or missing key");
			}
			return reply.code(401).send({ error: "invalid API key" });
		}
		if (!perKey.take(via)) {
			request.log.warn({ event: "accept.rate_limited", via }, "accept rate limited");
			return reply.code(429).send({ error: "too many requests" });
		}
		const parsed = body.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({ error: "body must be { by?: string }" });
		const by = parsed.data?.by;
		const acceptor: Acceptor = by ? { via, by } : { via };
		const context = { target, via, ...(by ? { by } : {}) };
		try {
			const call = await deps.accept(target, acceptor);
			request.log.info({ event: "accept.accepted", ...context, callId: call.callId }, "accepted");
			return reply.code(202).send({ callId: call.callId });
		} catch (error) {
			if (error instanceof NoSuchCall) {
				request.log.info({ event: "accept.no_call", ...context }, "nothing to accept");
				return reply.code(404).send({ error: "no ringing call" });
			}
			if (error instanceof AlreadyAccepted) {
				request.log.info(
					{ event: "accept.already_accepted", ...context, callId: error.callId },
					"already accepted",
				);
				return reply.code(409).send({
					error: "already accepted",
					callId: error.callId,
					via: error.winner?.via,
					...(error.winner?.by ? { by: error.winner.by } : {}),
				});
			}
			if (error instanceof AcceptTooLate) {
				request.log.info(
					{ event: "accept.too_late", ...context, callId: error.callId },
					"too late to accept",
				);
				return reply.code(410).send({ error: "too late", callId: error.callId });
			}
			throw error;
		}
	}

	app.post("/api/v1/calls/current/accept", (request, reply) => handle(request, reply, "current"));
	app.post("/api/v1/calls/:callId/accept", (request, reply) => {
		const parsed = params.safeParse(request.params);
		return handle(request, reply, parsed.success ? parsed.data.callId : "invalid");
	});
}

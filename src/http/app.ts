import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Logger } from "../observability/logger.ts";

export type AppDeps = {
	config: Pick<Config, "env" | "version" | "gitSha">;
	logger: Logger;
	/** Hooks Sentry's error handler in when Sentry is on. */
	onApp?: (app: FastifyInstance) => void;
};

/** Telnyx sends small JSON events; nothing legitimate is anywhere near this. */
export const BODY_LIMIT = 64 * 1024;

/** Just enough of a Telnyx webhook to log it. Verification and handling come in #9. */
const telnyxEnvelope = z.object({
	data: z.object({
		id: z.string().optional(),
		event_type: z.string().optional(),
	}),
});

export function buildApp({ config, logger, onApp }: AppDeps): FastifyInstance {
	const app = Fastify({
		// pino's Logger is a FastifyBaseLogger; widening it keeps FastifyInstance's default type.
		loggerInstance: logger as FastifyBaseLogger,
		bodyLimit: BODY_LIMIT,
		disableRequestLogging: true,
		// Container Apps' ingress sets X-Forwarded-For.
		trustProxy: true,
	});
	onApp?.(app);

	// One line per request, except the probes, which come every few seconds.
	app.addHook("onResponse", async (request, reply) => {
		if (request.url === "/healthz") return;
		request.log.info(
			{
				event: "http.request",
				method: request.method,
				path: request.routeOptions.url ?? "unmatched",
				status: reply.statusCode,
				ms: Math.round(reply.elapsedTime),
			},
			"request",
		);
	});

	// Process alive only: a slow dependency must never restart a replica that is
	// waking from zero to take a call (ADR 0003).
	app.get("/healthz", async () => ({ status: "ok" }));

	app.get("/version", async () => ({
		service: "pixel-phone",
		env: config.env,
		version: config.version,
		...(config.gitSha ? { sha: config.gitSha } : {}),
	}));

	// Stub until #9: acknowledges and logs what arrived, so the URL can be given to
	// Telnyx and the first number ordered (#7). It acts on nothing.
	app.post("/webhooks/telnyx", async (request) => {
		const parsed = telnyxEnvelope.safeParse(request.body);
		request.log.info(
			{
				event: "telnyx.webhook_stub",
				eventType: parsed.success ? parsed.data.data.event_type : undefined,
				eventId: parsed.success ? parsed.data.data.id : undefined,
				recognised: parsed.success,
			},
			"Telnyx webhook received (not verified or acted on yet)",
		);
		return { received: true };
	});

	return app;
}

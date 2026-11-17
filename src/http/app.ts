import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import type { Config } from "../config.ts";
import type { Logger } from "../observability/logger.ts";
import { type AcceptDeps, acceptRoutes } from "./accept.ts";
import { type TelnyxWebhookDeps, telnyxWebhookRoutes } from "./telnyx-webhook.ts";

export type AppDeps = {
	config: Pick<Config, "env" | "version" | "gitSha">;
	logger: Logger;
	/** The Telnyx webhook. Without it, the route answers 503. */
	telnyxWebhook?: TelnyxWebhookDeps;
	/** The accept API. Without it, the routes answer 503. */
	accept?: AcceptDeps;
	/** Hooks Sentry's error handler in when Sentry is on. */
	onApp?: (app: FastifyInstance) => void;
};

/** Telnyx sends small JSON events; nothing legitimate is anywhere near this. */
export const BODY_LIMIT = 64 * 1024;

export function buildApp({
	config,
	logger,
	telnyxWebhook,
	accept,
	onApp,
}: AppDeps): FastifyInstance {
	const app = Fastify({
		// pino's Logger is a FastifyBaseLogger; widening it keeps FastifyInstance's default type.
		loggerInstance: logger as FastifyBaseLogger,
		bodyLimit: BODY_LIMIT,
		// Fastify's own per-request lines are off; the onResponse hook below writes one line.
		logController: new LogController({ disableRequestLogging: true }),
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

	// Process alive only: a slow dependency must never restart the replica
	// that has to take the next call (ADR 0003).
	app.get("/healthz", async () => ({ status: "ok" }));

	app.get("/version", async () => ({
		service: "pixel-phone",
		env: config.env,
		version: config.version,
		...(config.gitSha ? { sha: config.gitSha } : {}),
	}));

	if (telnyxWebhook) {
		void app.register(telnyxWebhookRoutes, telnyxWebhook);
	} else {
		app.post("/webhooks/telnyx", async (_request, reply) =>
			reply.code(503).send({ error: "telnyx is not configured" }),
		);
	}

	void app.register(
		acceptRoutes,
		accept ?? { keys: undefined, accept: () => Promise.reject(new Error("not configured")) },
	);

	return app;
}

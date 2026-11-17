/**
 * Entry point: config, logger, HTTP server, shutdown. Started with
 * `node --import ./dist/instrument.js dist/index.js`, so Sentry is already set up.
 */
import * as Sentry from "@sentry/node";
import { MemorySeenEvents } from "./adapters/memory/seen-events.ts";
import { type StorageTarget, tableClient } from "./adapters/storage/clients.ts";
import { TableSeenEvents, WEBHOOK_EVENTS_TABLE } from "./adapters/storage/seen-events.ts";
import { telnyxPublicKey } from "./adapters/telnyx/webhook.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { systemClock } from "./core/clock.ts";
import type { TelephonyEventHandler } from "./core/telephony-events.ts";
import { buildApp } from "./http/app.ts";
import { createLogger } from "./observability/logger.ts";
import { createReporter } from "./observability/report.ts";

let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig();
} catch (error) {
	// There's no logger yet: this one plain line is the exception to "pino only".
	process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
	process.exit(1);
}

const logger = createLogger(config);
const report = createReporter(logger);
const clock = systemClock;

const storage: StorageTarget | undefined = config.azure.storageConnectionString
	? { kind: "connection-string", connectionString: config.azure.storageConnectionString }
	: config.azure.storageAccount
		? {
				kind: "azure",
				account: config.azure.storageAccount,
				...(config.azure.clientId ? { clientId: config.azure.clientId } : {}),
			}
		: undefined;

// Locally (Azurite) nothing has made the tables yet; in Azure, Terraform has.
if (storage?.kind === "connection-string") {
	await tableClient(storage, WEBHOOK_EVENTS_TABLE)
		.createTable()
		.catch((error: unknown) => report("storage", error, { during: "creating local tables" }));
}

const tableSeen = storage
	? new TableSeenEvents(tableClient(storage, WEBHOOK_EVENTS_TABLE))
	: undefined;
const seen = tableSeen ?? new MemorySeenEvents();

// Logs each verified event until the call flow is wired in (#16).
const handler: TelephonyEventHandler = {
	async handle(event) {
		logger.info(
			{
				event: "call.event",
				type: event.type,
				callControlId: event.callControlId,
				from: event.from,
				to: event.to,
			},
			"call event (not acted on yet)",
		);
	},
};

const app = buildApp({
	config,
	logger,
	telnyxWebhook: {
		publicKey: config.telnyx ? telnyxPublicKey(config.telnyx.publicKey) : undefined,
		seen,
		handler,
		clock,
		report,
	},
	onApp: (instance) => {
		if (config.sentry) Sentry.setupFastifyErrorHandler(instance);
	},
});

process.on("unhandledRejection", (reason) => {
	logger.error({ event: "process.unhandled_rejection", err: reason }, "unhandled rejection");
	Sentry.captureException(reason);
});

async function shutdown(signal: string) {
	logger.info({ event: "process.stopping", signal }, "stopping");
	try {
		await app.close();
		await Sentry.flush(2000);
	} finally {
		process.exit(0);
	}
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// Webhook IDs are only needed for a few minutes; keep two days and prune the rest.
async function pruneSeen() {
	if (!tableSeen) return;
	try {
		const deleted = await tableSeen.prune(new Date(clock.now().getTime() - 2 * 86_400_000));
		if (deleted > 0)
			logger.info({ event: "storage.pruned", table: WEBHOOK_EVENTS_TABLE, deleted }, "pruned");
	} catch (error) {
		report("storage", error, { during: "pruning WebhookEvents" });
	}
}
setInterval(() => void pruneSeen(), 6 * 3600_000).unref();
void pruneSeen();

await app.listen({ host: "0.0.0.0", port: config.port });
logger.info(
	{
		event: "process.started",
		port: config.port,
		telnyx: config.telnyx !== undefined,
		storage: storage?.kind ?? "memory",
		homeAssistant: config.homeAssistant !== undefined,
		acceptApi: config.apiKeys?.map((k) => k.id) ?? false,
		sentry: config.sentry !== undefined,
	},
	"pixel-phone is listening",
);

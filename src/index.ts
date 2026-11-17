/**
 * Entry point: config, adapters, the call flow, HTTP server, shutdown. Started with
 * `node --import ./dist/instrument.js dist/index.js`, so Sentry is already set up.
 */
import * as Sentry from "@sentry/node";
import { HomeAssistantRinger, NoRinger } from "./adapters/home-assistant/ringer.ts";
import { BlobMedia, blobServiceClient, NoMedia } from "./adapters/media/blob-media.ts";
import { MemoryCallStore } from "./adapters/memory/call-store.ts";
import { MemorySeenEvents } from "./adapters/memory/seen-events.ts";
import { LogPublisher, queueClient, StorageQueuePublisher } from "./adapters/queue/publisher.ts";
import { CALL_RETENTION_DAYS, CALLS_TABLE, TableCallStore } from "./adapters/storage/call-store.ts";
import { type StorageTarget, tableClient } from "./adapters/storage/clients.ts";
import { TableSeenEvents, WEBHOOK_EVENTS_TABLE } from "./adapters/storage/seen-events.ts";
import { TelnyxTelephony } from "./adapters/telnyx/telephony.ts";
import { telnyxPublicKey } from "./adapters/telnyx/webhook.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { CallFlow } from "./core/call-flow.ts";
import { systemClock } from "./core/clock.ts";
import { TelephonyFailed } from "./core/errors.ts";
import type { Telephony } from "./core/telephony.ts";
import { ApiKeys } from "./http/api-keys.ts";
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

// --- Storage: Azure with the app's identity, Azurite locally, or memory -------------

const storage: StorageTarget | undefined = config.azure.storageConnectionString
	? { kind: "connection-string", connectionString: config.azure.storageConnectionString }
	: config.azure.storageAccount
		? {
				kind: "azure",
				account: config.azure.storageAccount,
				...(config.azure.clientId ? { clientId: config.azure.clientId } : {}),
			}
		: undefined;

// Locally (Azurite) nothing has made the tables, queue or container; in Azure, Terraform has.
if (storage?.kind === "connection-string") {
	const make = (what: string, p: Promise<unknown>) =>
		p.catch((error: unknown) => {
			if ((error as { statusCode?: number }).statusCode !== 409) {
				report("storage", error, { during: `creating local ${what}` });
			}
		});
	await Promise.all([
		make(CALLS_TABLE, tableClient(storage, CALLS_TABLE).createTable()),
		make(WEBHOOK_EVENTS_TABLE, tableClient(storage, WEBHOOK_EVENTS_TABLE).createTable()),
		make("queue", queueClient(storage, config.azure.eventsQueue).createIfNotExists()),
		make(
			"media container",
			blobServiceClient(storage)
				.getContainerClient(config.azure.mediaContainer)
				.createIfNotExists(),
		),
	]);
}

const tableSeen = storage
	? new TableSeenEvents(tableClient(storage, WEBHOOK_EVENTS_TABLE))
	: undefined;
const tableCalls = storage ? new TableCallStore(tableClient(storage, CALLS_TABLE)) : undefined;

// --- The other adapters ------------------------------------------------------------

const telephony: Telephony = config.telnyx
	? new TelnyxTelephony({
			apiKey: config.telnyx.apiKey,
			...(config.telnyx.apiUrl ? { baseUrl: config.telnyx.apiUrl } : {}),
		})
	: {
			answer: () => Promise.reject(new TelephonyFailed("Telnyx isn't configured")),
			play: () => Promise.reject(new TelephonyFailed("Telnyx isn't configured")),
			hangup: () => Promise.reject(new TelephonyFailed("Telnyx isn't configured")),
		};

const ringer = config.homeAssistant
	? new HomeAssistantRinger({
			url: config.homeAssistant.url,
			token: config.homeAssistant.token,
			entityId: config.homeAssistant.ringingEntity,
		})
	: new NoRinger((on) =>
			logger.info(
				{ event: "ringer.off", ringing: on },
				"Home Assistant isn't configured: not ringing",
			),
		);

const publisher = storage
	? new StorageQueuePublisher(queueClient(storage, config.azure.eventsQueue))
	: new LogPublisher((event) =>
			logger.info({ event: "queue.off", phoneEvent: event }, "no queue configured: event logged"),
		);

const media = storage
	? new BlobMedia(blobServiceClient(storage), config.azure.mediaContainer, storage.kind)
	: new NoMedia();

const flow = new CallFlow({
	store: tableCalls ?? new MemoryCallStore(),
	clock,
	telephony,
	ringer,
	publisher,
	media,
	recording: config.recordingAccepted,
	acceptWindowMs: config.acceptWindowSeconds * 1000,
	observer: {
		log: (event, fields) => logger.info({ event, ...fields }, event),
		fail: (area, error, fields) => report(area, error, fields),
	},
});

// --- HTTP -----------------------------------------------------------------------------

const app = buildApp({
	config,
	logger,
	telnyxWebhook: {
		publicKey: config.telnyx ? telnyxPublicKey(config.telnyx.publicKey) : undefined,
		seen: tableSeen ?? new MemorySeenEvents(),
		handler: flow,
		clock,
		report,
	},
	accept: {
		keys: config.apiKeys ? new ApiKeys(config.apiKeys) : undefined,
		accept: (target, acceptor) => flow.accept(target, acceptor),
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
		flow.stop();
		await Promise.race([flow.idle(), new Promise((r) => setTimeout(r, 5000))]);
		await Sentry.flush(2000);
	} finally {
		process.exit(0);
	}
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// --- Housekeeping: webhook IDs are kept two days, calls 90 ----------------------------

async function prune() {
	const now = clock.now().getTime();
	try {
		const seen = (await tableSeen?.prune(new Date(now - 2 * 86_400_000))) ?? 0;
		const calls = (await tableCalls?.prune(new Date(now - CALL_RETENTION_DAYS * 86_400_000))) ?? 0;
		if (seen + calls > 0) logger.info({ event: "storage.pruned", seen, calls }, "pruned old rows");
	} catch (error) {
		report("storage", error, { during: "pruning" });
	}
}
setInterval(() => void prune(), 6 * 3600_000).unref();
void prune();

await flow.start();
await app.listen({ host: "0.0.0.0", port: config.port });
logger.info(
	{
		event: "process.started",
		port: config.port,
		telnyx: config.telnyx !== undefined,
		storage: storage?.kind ?? "memory",
		homeAssistant: config.homeAssistant?.ringingEntity ?? false,
		acceptApi: config.apiKeys?.map((k) => k.id) ?? false,
		acceptWindowSeconds: config.acceptWindowSeconds,
		recording: config.recordingAccepted,
		sentry: config.sentry !== undefined,
	},
	"pixel-phone is listening",
);

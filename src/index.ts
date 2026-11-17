/**
 * Entry point: config, logger, HTTP server, shutdown. Started with
 * `node --import ./dist/instrument.js dist/index.js`, so Sentry is already set up.
 */
import * as Sentry from "@sentry/node";
import { ConfigError, loadConfig } from "./config.ts";
import { buildApp } from "./http/app.ts";
import { createLogger } from "./observability/logger.ts";

let config: ReturnType<typeof loadConfig>;
try {
	config = loadConfig();
} catch (error) {
	// There's no logger yet: this one plain line is the exception to "pino only".
	process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
	process.exit(1);
}

const logger = createLogger(config);
const app = buildApp({
	config,
	logger,
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

await app.listen({ host: "0.0.0.0", port: config.port });
logger.info(
	{
		event: "process.started",
		port: config.port,
		telnyx: config.telnyx !== undefined,
		homeAssistant: config.homeAssistant !== undefined,
		acceptApi: config.apiKeysYaml !== undefined,
		sentry: config.sentry !== undefined,
	},
	"pixel-phone is listening",
);

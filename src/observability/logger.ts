import pino, { type DestinationStream, type Logger } from "pino";
import type { Config } from "../config.ts";
import { scrubString } from "./scrub.ts";

export type { Logger };

/** Paths pino replaces with "[redacted]" wherever they appear in a log entry. */
export const REDACT_PATHS = [
	"token",
	"*.token",
	"apiKey",
	"*.apiKey",
	"key",
	"*.key",
	"headers.authorization",
	"*.headers.authorization",
	'headers["telnyx-signature-ed25519"]',
	'*.headers["telnyx-signature-ed25519"]',
];

export type LogConfig = Pick<Config, "env" | "logLevel" | "version">;

/**
 * The one logger (ADR 0009): JSON lines on stdout, which Container Apps sends to Log
 * Analytics, and Sentry Logs through Sentry's pino integration (`instrument.ts`).
 * Whatever is written has token shapes masked (`scrub.ts`).
 */
export function createLogger(config: LogConfig, destination?: DestinationStream): Logger {
	const options = {
		level: config.logLevel,
		base: { service: "pixel-phone", env: config.env, version: config.version },
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		// The patterns only match token shapes, which hold no quotes, so lines stay valid JSON.
		hooks: { streamWrite: scrubString },
	};
	return destination ? pino(options, destination) : pino(options);
}

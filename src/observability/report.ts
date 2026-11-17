/**
 * Reporting a failure that was handled (the request still got an answer, the call still
 * rings out) but someone should know about. Sentry when it's on, and always a log line.
 */
import * as Sentry from "@sentry/node";
import type { Logger } from "./logger.ts";

/** Which dependency or part failed. Becomes the Sentry `area` tag. */
export type Area =
	| "telnyx"
	| "telnyx-webhook"
	| "home-assistant"
	| "queue"
	| "storage"
	| "media"
	| "call-flow";

export type Report = (area: Area, error: unknown, context?: Record<string, unknown>) => void;

export function createReporter(logger: Logger): Report {
	return (area, error, context = {}) => {
		logger.error({ event: `${area}.failed`, area, err: error, ...context }, `${area} failed`);
		Sentry.withScope((scope) => {
			scope.setTag("area", area);
			for (const [key, value] of Object.entries(context)) scope.setExtra(key, value);
			Sentry.captureException(error);
		});
	};
}

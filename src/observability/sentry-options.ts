import * as Sentry from "@sentry/node";
import type { SentryConfig } from "../config.ts";
import { scrubDeep } from "./scrub.ts";

/** Log levels sent to Sentry Logs. Failures reach Sentry as events, not through logs. */
export const SENTRY_LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;

/** Container Apps' probes hit this. It isn't worth a trace or a session. */
export function isHealthProbe(urlPath: string): boolean {
	const path = urlPath.split("?")[0] ?? urlPath;
	return path === "/healthz";
}

/** The Sentry settings, in one place so they can be tested. `instrument.ts` passes them on. */
export function sentryOptions(sentry: SentryConfig): Sentry.NodeOptions {
	return {
		dsn: sentry.dsn,
		environment: sentry.environment,
		release: sentry.release,
		// Collect nothing by default: headers carry API keys and Telnyx signatures, and
		// stack frame variables can hold tokens.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			stackFrameVariables: false,
		},
		includeServerName: false,
		sampleRate: 1,
		tracesSampleRate: sentry.tracesSampleRate,
		integrations: [
			Sentry.httpIntegration({ ignoreIncomingRequests: isHealthProbe, sessions: false }),
			Sentry.pinoIntegration({ log: { levels: [...SENTRY_LOG_LEVELS] } }),
		],
		beforeSend: (event) => scrubDeep(event),
		beforeSendSpan: (span) => scrubDeep(span),
		beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
		beforeSendLog: (log) => scrubDeep(log),
	};
}

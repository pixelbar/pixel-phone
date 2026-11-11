import { describe, expect, it } from "vitest";
import { isHealthProbe, sentryOptions } from "../../src/observability/sentry-options.ts";

describe("sentryOptions", () => {
	const options = sentryOptions({
		dsn: "https://k@example.invalid/1",
		environment: "dev",
		release: "abc",
		tracesSampleRate: 0.2,
	});

	it("sends to the right environment and release, collecting nothing personal", () => {
		expect(options).toMatchObject({
			dsn: "https://k@example.invalid/1",
			environment: "dev",
			release: "abc",
			tracesSampleRate: 0.2,
			includeServerName: false,
			dataCollection: { httpHeaders: false, httpBodies: [], stackFrameVariables: false },
		});
	});

	it("scrubs events, spans, breadcrumbs and logs", () => {
		const secret = `KEY${"0A".repeat(12)}_${"z".repeat(20)}`;
		const event = options.beforeSend?.({ message: secret } as never, {} as never);
		expect(JSON.stringify(event)).not.toContain(secret);
		expect(
			JSON.stringify(options.beforeSendSpan?.({ description: secret } as never)),
		).not.toContain(secret);
		expect(JSON.stringify(options.beforeBreadcrumb?.({ message: secret } as never))).not.toContain(
			secret,
		);
		expect(JSON.stringify(options.beforeSendLog?.({ message: secret } as never))).not.toContain(
			secret,
		);
	});

	it("ignores only the health probe", () => {
		expect(isHealthProbe("/healthz")).toBe(true);
		expect(isHealthProbe("/healthz?x=1")).toBe(true);
		expect(isHealthProbe("/webhooks/telnyx")).toBe(false);
	});
});

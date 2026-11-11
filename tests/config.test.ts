import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadSentryConfig } from "../src/config.ts";

const FAKE_KEY = "fake-telnyx-key";
const HA = {
	HOME_ASSISTANT_URL: "https://example.invalid",
	HOME_ASSISTANT_TOKEN: "fake-ha-token",
	HOME_ASSISTANT_RINGING_ENTITY: "input_boolean.pixel_phone_ringing_dev",
};

function problem(env: NodeJS.ProcessEnv): string {
	try {
		loadConfig(env);
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
	throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
	it("has local defaults", () => {
		expect(loadConfig({})).toEqual({
			env: "local",
			port: 3000,
			logLevel: "info",
			version: "dev",
			azure: { eventsQueue: "phone-events", mediaContainer: "media" },
		});
	});

	it("reads everything, treating empty values as unset", () => {
		const config = loadConfig({
			PIXEL_PHONE_ENV: "dev",
			PORT: "8080",
			LOG_LEVEL: "debug",
			PIXEL_PHONE_VERSION: "abc123",
			PIXEL_PHONE_GIT_SHA: "abc123",
			TELNYX_API_KEY: FAKE_KEY,
			TELNYX_PUBLIC_KEY: "fake-public-key",
			...HA,
			API_KEYS_YAML: "- { id: pixel, key: fake }",
			SENTRY_DSN: "https://public@example.invalid/1",
			AZURE_CLIENT_ID: "client",
			AZURE_STORAGE_ACCOUNT_NAME: "pixelphonedevst",
			SENTRY_TRACES_SAMPLE_RATE: "",
		});
		expect(config).toMatchObject({
			env: "dev",
			port: 8080,
			logLevel: "debug",
			gitSha: "abc123",
			telnyx: { apiKey: FAKE_KEY, publicKey: "fake-public-key" },
			homeAssistant: { ringingEntity: "input_boolean.pixel_phone_ringing_dev" },
			apiKeysYaml: "- { id: pixel, key: fake }",
			sentry: { environment: "dev", release: "abc123", tracesSampleRate: 0.2 },
			azure: { clientId: "client", storageAccount: "pixelphonedevst" },
		});
	});

	it("names bad settings without echoing their values", () => {
		const message = problem({
			PORT: "not-a-port",
			PIXEL_PHONE_ENV: "staging",
			SENTRY_DSN: "secret-ish",
		});
		expect(message).toMatch(/PORT/);
		expect(message).toMatch(/PIXEL_PHONE_ENV/);
		expect(message).toMatch(/SENTRY_DSN/);
		expect(message).not.toContain("secret-ish");
	});

	it("needs Telnyx's and Home Assistant's settings together", () => {
		expect(problem({ TELNYX_API_KEY: FAKE_KEY })).toMatch(/TELNYX_PUBLIC_KEY must be set together/);
		expect(problem({ HOME_ASSISTANT_URL: HA.HOME_ASSISTANT_URL })).toMatch(
			/HOME_ASSISTANT_TOKEN must be set together/,
		);
		expect(problem({ ...HA, HOME_ASSISTANT_RINGING_ENTITY: undefined })).toMatch(
			/HOME_ASSISTANT_RINGING_ENTITY must be set when Home Assistant is/,
		);
		expect(problem({ TELNYX_API_KEY: FAKE_KEY })).not.toContain(FAKE_KEY);
	});

	it("accepts the ringing entity on its own, as Terraform sets it on dev before Home Assistant is", () => {
		const config = loadConfig({
			PIXEL_PHONE_ENV: "dev",
			HOME_ASSISTANT_RINGING_ENTITY: HA.HOME_ASSISTANT_RINGING_ENTITY,
		});
		expect(config.homeAssistant).toBeUndefined();
	});

	it("keeps dev and local off the real siren", () => {
		const real = { ...HA, HOME_ASSISTANT_RINGING_ENTITY: "input_boolean.pixel_phone_ringing" };
		expect(problem({ ...real, PIXEL_PHONE_ENV: "dev" })).toMatch(/_dev helper/);
		expect(problem(real)).toMatch(/_dev helper/);
		expect(loadConfig({ ...real, PIXEL_PHONE_ENV: "prod" }).homeAssistant?.ringingEntity).toBe(
			"input_boolean.pixel_phone_ringing",
		);
		expect(problem({ ...HA, HOME_ASSISTANT_RINGING_ENTITY: "light.siren" })).toMatch(
			/input_boolean/,
		);
	});
});

describe("loadSentryConfig", () => {
	it("is off without a DSN or with a broken config, and on with one", () => {
		expect(loadSentryConfig({})).toBeUndefined();
		expect(
			loadSentryConfig({ SENTRY_DSN: "https://k@example.invalid/1", PORT: "x" }),
		).toBeUndefined();
		expect(
			loadSentryConfig({
				SENTRY_DSN: "https://k@example.invalid/1",
				SENTRY_TRACES_SAMPLE_RATE: "1",
			}),
		).toEqual({
			dsn: "https://k@example.invalid/1",
			environment: "local",
			release: "dev",
			tracesSampleRate: 1,
		});
	});
});

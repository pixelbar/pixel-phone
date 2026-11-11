/**
 * pixel-phone's configuration, validated with zod. The ONLY place that reads
 * `process.env`. Settings that only work together (Telnyx, Home Assistant) are
 * all set or none. Errors name the setting, never its value.
 */
import { z } from "zod";

export const ENVIRONMENTS = ["local", "dev", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const text = z.string().trim().min(1);

const schema = z.object({
	PIXEL_PHONE_ENV: z.enum(ENVIRONMENTS).default("local"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
	PIXEL_PHONE_VERSION: text.default("dev"),
	PIXEL_PHONE_GIT_SHA: text.optional(),

	// Telnyx Call Control (secrets: telnyx-api-key, telnyx-public-key)
	TELNYX_API_KEY: text.optional(),
	TELNYX_PUBLIC_KEY: text.optional(),

	// Home Assistant (secret: home-assistant-token)
	HOME_ASSISTANT_URL: z.url({ protocol: /^https?$/ }).optional(),
	HOME_ASSISTANT_TOKEN: text.optional(),
	HOME_ASSISTANT_RINGING_ENTITY: z
		.string()
		.regex(/^input_boolean\.[a-z0-9_]+$/, { error: "must be an input_boolean entity ID" })
		.optional(),

	// The accept API's callers (secret: api-keys-yaml)
	API_KEYS_YAML: text.optional(),

	// Sentry (secret: sentry-dsn)
	SENTRY_DSN: z.url().optional(),
	SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

	// Azure, set by Terraform on the Container App
	AZURE_CLIENT_ID: text.optional(),
	AZURE_STORAGE_ACCOUNT_NAME: text.optional(),
	PHONE_EVENTS_QUEUE: text.default("phone-events"),
	MEDIA_CONTAINER: text.default("media"),
});

type Env = z.infer<typeof schema>;

export type TelnyxConfig = { apiKey: string; publicKey: string };
export type HomeAssistantConfig = { url: string; token: string; ringingEntity: string };
export type SentryConfig = {
	dsn: string;
	environment: Environment;
	release: string;
	tracesSampleRate: number;
};

export type Config = {
	env: Environment;
	port: number;
	logLevel: LogLevel;
	version: string;
	gitSha?: string;
	telnyx?: TelnyxConfig;
	homeAssistant?: HomeAssistantConfig;
	apiKeysYaml?: string;
	sentry?: SentryConfig;
	azure: {
		clientId?: string;
		storageAccount?: string;
		eventsQueue: string;
		mediaContainer: string;
	};
};

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Empty values (`KEY=` in an env file) count as unset. */
function withoutEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && value.trim() !== "") out[key] = value;
	}
	return out;
}

function allOrNone(env: Env, keys: readonly (keyof Env)[], problems: string[]): boolean {
	const set = keys.filter((key) => env[key] !== undefined);
	if (set.length === 0) return false;
	if (set.length < keys.length) {
		const missing = keys.filter((key) => env[key] === undefined);
		problems.push(`${missing.join(", ")} must be set together with ${set.join(", ")}`);
		return false;
	}
	return true;
}

function sentryFrom(env: Env): SentryConfig | undefined {
	if (!env.SENTRY_DSN) return undefined;
	return {
		dsn: env.SENTRY_DSN,
		environment: env.PIXEL_PHONE_ENV,
		release: env.PIXEL_PHONE_VERSION,
		tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ?? 0.2,
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = schema.safeParse(withoutEmpty(env));
	if (!result.success) {
		const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
		throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
	}
	const data = result.data;
	const problems: string[] = [];

	const telnyx = allOrNone(data, ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"], problems);
	// The URL and token switch Home Assistant on. The entity may be set on its own:
	// Terraform always pins dev's to the _dev helper, before Home Assistant is set up.
	const homeAssistant = allOrNone(data, ["HOME_ASSISTANT_URL", "HOME_ASSISTANT_TOKEN"], problems);
	if (homeAssistant && data.HOME_ASSISTANT_RINGING_ENTITY === undefined) {
		problems.push(
			"HOME_ASSISTANT_RINGING_ENTITY must be set when Home Assistant is (HOME_ASSISTANT_URL)",
		);
	}
	// dev never touches the real siren (ADR 0005).
	if (
		data.PIXEL_PHONE_ENV !== "prod" &&
		data.HOME_ASSISTANT_RINGING_ENTITY !== undefined &&
		!data.HOME_ASSISTANT_RINGING_ENTITY.endsWith("_dev")
	) {
		problems.push(
			`HOME_ASSISTANT_RINGING_ENTITY must be a _dev helper outside prod (PIXEL_PHONE_ENV=${data.PIXEL_PHONE_ENV})`,
		);
	}
	if (problems.length > 0) {
		throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}

	const sentry = sentryFrom(data);
	return {
		env: data.PIXEL_PHONE_ENV,
		port: data.PORT,
		logLevel: data.LOG_LEVEL,
		version: data.PIXEL_PHONE_VERSION,
		...(data.PIXEL_PHONE_GIT_SHA ? { gitSha: data.PIXEL_PHONE_GIT_SHA } : {}),
		...(telnyx && data.TELNYX_API_KEY && data.TELNYX_PUBLIC_KEY
			? { telnyx: { apiKey: data.TELNYX_API_KEY, publicKey: data.TELNYX_PUBLIC_KEY } }
			: {}),
		...(homeAssistant &&
		data.HOME_ASSISTANT_URL &&
		data.HOME_ASSISTANT_TOKEN &&
		data.HOME_ASSISTANT_RINGING_ENTITY
			? {
					homeAssistant: {
						url: data.HOME_ASSISTANT_URL,
						token: data.HOME_ASSISTANT_TOKEN,
						ringingEntity: data.HOME_ASSISTANT_RINGING_ENTITY,
					},
				}
			: {}),
		...(data.API_KEYS_YAML ? { apiKeysYaml: data.API_KEYS_YAML } : {}),
		...(sentry ? { sentry } : {}),
		azure: {
			...(data.AZURE_CLIENT_ID ? { clientId: data.AZURE_CLIENT_ID } : {}),
			...(data.AZURE_STORAGE_ACCOUNT_NAME
				? { storageAccount: data.AZURE_STORAGE_ACCOUNT_NAME }
				: {}),
			eventsQueue: data.PHONE_EVENTS_QUEUE,
			mediaContainer: data.MEDIA_CONTAINER,
		},
	};
}

/**
 * Just Sentry's settings, for `instrument.ts`, which runs before anything else. Never
 * throws: a broken config is reported properly by `loadConfig` in `index.ts`.
 */
export function loadSentryConfig(env: NodeJS.ProcessEnv = process.env): SentryConfig | undefined {
	const result = schema.safeParse(withoutEmpty(env));
	return result.success ? sentryFrom(result.data) : undefined;
}

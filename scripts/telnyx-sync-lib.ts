/**
 * The logic behind `just telnyx-sync <env>` (ADR 0007): what the Telnyx side should look
 * like for an environment, how that differs from what Telnyx has, and the API calls that
 * close the gap. The CLI (`telnyx-sync.ts`) adds the laptop parts: reading the key, finding
 * the host, asking before it writes.
 *
 * The API key is only ever put in the Authorization header. Errors carry Telnyx's error
 * title and the HTTP status, never the request.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Target } from "./envs.ts";

export const TELNYX_API = "https://api.telnyx.com";

/** Enough lines for a second doorbell call to arrive (and ring out) while one is active. */
export const INBOUND_CHANNEL_LIMIT = 2;

/** Each Telnyx request gets this long. A sync is run by hand, so it may wait a bit. */
const REQUEST_TIMEOUT_MS = 15_000;

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, { error: "must be an E.164 number like +31…" });
const hostname = z
	.string()
	.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, { error: "must be a bare hostname, no scheme or path" });

const fileSchema = z.strictObject({
	/** Defaults to pixel-phone-<env>. */
	application: z.string().min(1).optional(),
	/** Defaults to the Container App's ingress hostname. Prod sets phone.pixelbar.nl. */
	host: hostname.optional(),
	/** A second hostname Telnyx falls back to when the first doesn't answer. */
	failover_host: hostname.optional(),
	numbers: z.array(e164).default([]),
});

export type TelnyxEnvFile = z.infer<typeof fileSchema>;

export function telnyxConfigFile(target: Target): string {
	return `config/telnyx.${target}.yaml`;
}

export function parseTelnyxEnvFile(text: string, file = "config"): TelnyxEnvFile {
	const result = fileSchema.safeParse(parse(text) ?? {});
	if (!result.success) {
		const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
		throw new Error(`${file} is invalid:\n${problems.join("\n")}`);
	}
	return result.data;
}

export function loadTelnyxEnvFile(target: Target): TelnyxEnvFile {
	const file = telnyxConfigFile(target);
	return parseTelnyxEnvFile(readFileSync(file, "utf8"), file);
}

/** The settings we own on the Call Control application. Anything else is left alone. */
export type DesiredApplication = {
	application_name: string;
	webhook_event_url: string;
	webhook_event_failover_url: string;
	webhook_api_version: "2";
	first_command_timeout: false;
	active: true;
	channel_limit: number;
};

export function desiredApplication(
	target: Target,
	file: TelnyxEnvFile,
	host: string,
): DesiredApplication {
	return {
		application_name: file.application ?? `pixel-phone-${target}`,
		webhook_event_url: `https://${host}/webhooks/telnyx`,
		webhook_event_failover_url: file.failover_host
			? `https://${file.failover_host}/webhooks/telnyx`
			: "",
		webhook_api_version: "2",
		// pixel-phone sends no command until someone accepts (ADR 0002). Telnyx must not
		// drop a call that is waiting.
		first_command_timeout: false,
		active: true,
		channel_limit: INBOUND_CHANNEL_LIMIT,
	};
}

export type TelnyxApplication = {
	id: string;
	application_name: string;
	webhook_event_url?: string | null;
	webhook_event_failover_url?: string | null;
	webhook_api_version?: string | null;
	first_command_timeout?: boolean | null;
	active?: boolean | null;
	inbound?: { channel_limit?: number | null } & Record<string, unknown>;
};

export type TelnyxNumber = { id: string; phone_number: string; connection_id?: string | null };

export type Change = { field: string; from: unknown; to: unknown };

/** Telnyx returns "" or null for an unset URL; both mean "none". */
const blank = (value: unknown) => (value === null || value === undefined ? "" : value);

export function applicationChanges(
	current: TelnyxApplication | undefined,
	desired: DesiredApplication,
): Change[] {
	const pairs: [string, unknown, unknown][] = [
		["webhook_event_url", current?.webhook_event_url, desired.webhook_event_url],
		[
			"webhook_event_failover_url",
			blank(current?.webhook_event_failover_url),
			desired.webhook_event_failover_url,
		],
		["webhook_api_version", current?.webhook_api_version, desired.webhook_api_version],
		["first_command_timeout", current?.first_command_timeout, desired.first_command_timeout],
		["active", current?.active, desired.active],
		["inbound.channel_limit", current?.inbound?.channel_limit, desired.channel_limit],
	];
	return pairs
		.filter(([, from, to]) => blank(from) !== to)
		.map(([field, from, to]) => ({ field, from: current ? from : undefined, to }));
}

export type NumberPlan = {
	phone_number: string;
	id?: string;
	from?: string | null;
	/** Missing: the number isn't on this Telnyx account. */
	found: boolean;
};

export type Plan = {
	target: Target;
	desired: DesiredApplication;
	application: TelnyxApplication | undefined;
	/** More than one application with this name: refuse to guess. */
	duplicates: number;
	applicationChanges: Change[];
	numbers: NumberPlan[];
};

/** The numbers that need pointing at the application. */
export function numbersToMove(plan: Plan): NumberPlan[] {
	return plan.numbers.filter(
		(n) => n.found && (plan.application === undefined || n.from !== plan.application.id),
	);
}

export function hasChanges(plan: Plan): boolean {
	return (
		plan.application === undefined ||
		plan.applicationChanges.length > 0 ||
		numbersToMove(plan).length > 0
	);
}

/** Problems that stop a sync. A missing number can't be fixed by syncing. */
export function planProblems(plan: Plan): string[] {
	const problems: string[] = [];
	if (plan.duplicates > 1) {
		problems.push(
			`Telnyx has ${plan.duplicates} applications named ${plan.desired.application_name}. Delete the extras in the portal first.`,
		);
	}
	for (const n of plan.numbers) {
		if (!n.found) problems.push(`${n.phone_number} isn't a number on this Telnyx account.`);
	}
	return problems;
}

const show = (value: unknown) =>
	value === undefined || value === "" ? "(none)" : JSON.stringify(value);

export function formatPlan(plan: Plan): string {
	const lines: string[] = [];
	const name = plan.desired.application_name;
	if (plan.application === undefined) {
		lines.push(`+ create Call Control application ${name}`);
		for (const c of plan.applicationChanges) lines.push(`    ${c.field}: ${show(c.to)}`);
	} else if (plan.applicationChanges.length === 0) {
		lines.push(`  application ${name} (${plan.application.id}) is up to date`);
	} else {
		lines.push(`~ update application ${name} (${plan.application.id})`);
		for (const c of plan.applicationChanges) {
			lines.push(`    ${c.field}: ${show(c.from)} → ${show(c.to)}`);
		}
	}
	const moving = new Set(numbersToMove(plan).map((n) => n.phone_number));
	for (const n of plan.numbers) {
		if (!n.found) lines.push(`! ${n.phone_number} isn't on this Telnyx account`);
		else if (moving.has(n.phone_number)) {
			lines.push(`~ point ${n.phone_number} at ${name} (now ${n.from ? n.from : "nothing"})`);
		} else lines.push(`  ${n.phone_number} already points at ${name}`);
	}
	return lines.join("\n");
}

export class TelnyxApiError extends Error {
	override name = "TelnyxApiError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

type Fetch = typeof globalThis.fetch;

/** A minimal Telnyx v2 client for the sync. Not used by the app (that's src/adapters/telnyx). */
export class TelnyxAdminApi {
	constructor(
		private readonly apiKey: string,
		private readonly baseUrl = TELNYX_API,
		private readonly fetchImpl: Fetch = globalThis.fetch,
	) {}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.name : "error";
			throw new TelnyxApiError(0, `${method} ${path} didn't reach Telnyx (${reason}).`);
		}
		const text = await response.text();
		if (!response.ok) {
			let title = response.statusText;
			try {
				const parsed = JSON.parse(text) as { errors?: { title?: string; detail?: string }[] };
				title = parsed.errors?.[0]?.detail ?? parsed.errors?.[0]?.title ?? title;
			} catch {
				// Not JSON: keep the status text.
			}
			const hint = response.status === 401 ? " Is TELNYX_API_KEY right for this account?" : "";
			throw new TelnyxApiError(
				response.status,
				`${method} ${path} failed: ${response.status} ${title}.${hint}`,
			);
		}
		return (text === "" ? {} : JSON.parse(text)) as T;
	}

	async applicationsNamed(name: string): Promise<TelnyxApplication[]> {
		const query = new URLSearchParams({
			"filter[application_name][contains]": name,
			"page[size]": "250",
		});
		const { data } = await this.request<{ data: TelnyxApplication[] }>(
			"GET",
			`/v2/call_control_applications?${query}`,
		);
		// "contains" also matches pixel-phone-dev-old; only an exact name counts.
		return data.filter((app) => app.application_name === name);
	}

	async createApplication(desired: DesiredApplication): Promise<TelnyxApplication> {
		const { channel_limit, ...rest } = desired;
		const { data } = await this.request<{ data: TelnyxApplication }>(
			"POST",
			"/v2/call_control_applications",
			{ ...rest, inbound: { channel_limit } },
		);
		return data;
	}

	async updateApplication(
		current: TelnyxApplication,
		desired: DesiredApplication,
	): Promise<TelnyxApplication> {
		const { channel_limit, ...rest } = desired;
		const { data } = await this.request<{ data: TelnyxApplication }>(
			"PATCH",
			`/v2/call_control_applications/${encodeURIComponent(current.id)}`,
			// Keep the inbound settings we don't own (SIP subdomain and so on).
			{ ...rest, inbound: { ...current.inbound, channel_limit } },
		);
		return data;
	}

	async number(phoneNumber: string): Promise<TelnyxNumber | undefined> {
		const query = new URLSearchParams({ "filter[phone_number]": phoneNumber });
		const { data } = await this.request<{ data: TelnyxNumber[] }>(
			"GET",
			`/v2/phone_numbers?${query}`,
		);
		return data.find((n) => n.phone_number === phoneNumber);
	}

	async pointNumber(id: string, connectionId: string): Promise<void> {
		await this.request("PATCH", `/v2/phone_numbers/${encodeURIComponent(id)}`, {
			connection_id: connectionId,
		});
	}
}

export async function makePlan(
	api: TelnyxAdminApi,
	target: Target,
	file: TelnyxEnvFile,
	host: string,
): Promise<Plan> {
	const desired = desiredApplication(target, file, host);
	const apps = await api.applicationsNamed(desired.application_name);
	const application = apps[0];
	const numbers = await Promise.all(
		file.numbers.map(async (phone_number): Promise<NumberPlan> => {
			const n = await api.number(phone_number);
			return n
				? { phone_number, id: n.id, from: n.connection_id ?? null, found: true }
				: { phone_number, found: false };
		}),
	);
	return {
		target,
		desired,
		application,
		duplicates: apps.length,
		applicationChanges: applicationChanges(application, desired),
		numbers,
	};
}

/** Makes Telnyx match the plan. Returns the application's ID. */
export async function applyPlan(api: TelnyxAdminApi, plan: Plan): Promise<string> {
	let app = plan.application;
	if (app === undefined) app = await api.createApplication(plan.desired);
	else if (plan.applicationChanges.length > 0) app = await api.updateApplication(app, plan.desired);
	for (const n of plan.numbers) {
		if (n.found && n.id !== undefined && n.from !== app.id) await api.pointNumber(n.id, app.id);
	}
	return app.id;
}

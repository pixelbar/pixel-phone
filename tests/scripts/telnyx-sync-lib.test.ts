import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applicationChanges,
	applyPlan,
	desiredApplication,
	formatPlan,
	hasChanges,
	isHostname,
	loadTelnyxEnvFile,
	makePlan,
	parseTelnyxEnvFile,
	planProblems,
	TelnyxAdminApi,
	TelnyxApiError,
} from "../../scripts/telnyx-sync-lib.ts";
import { type FakeTelnyxApi, startFakeTelnyxApi } from "../../src/testing/fake-telnyx-api.ts";

const HOST = "pixel-phone-dev.example.azurecontainerapps.io";
const NUMBER = "+31103024128";
const FILE = parseTelnyxEnvFile(`application: pixel-phone-dev\nnumbers: ["${NUMBER}"]\n`);

let fake: FakeTelnyxApi;
let api: TelnyxAdminApi;

beforeEach(async () => {
	fake = await startFakeTelnyxApi();
	fake.numbers = [{ id: "num-1", phone_number: NUMBER, connection_id: null }];
	api = new TelnyxAdminApi(fake.apiKey, fake.url);
});
afterEach(() => fake.close());

describe("config/telnyx.<env>.yaml", () => {
	it("parses the committed files", () => {
		expect(loadTelnyxEnvFile("dev").numbers).toEqual([NUMBER]);
		expect(loadTelnyxEnvFile("prod").host).toBe("phone.pixelbar.nl");
	});

	it("rejects numbers that aren't E.164, hosts with a scheme, and unknown keys", () => {
		expect(() => parseTelnyxEnvFile("numbers: ['0103024128']")).toThrow(/E.164/);
		expect(() => parseTelnyxEnvFile("host: https://x.example.com")).toThrow(/bare hostname/);
		expect(() => parseTelnyxEnvFile("nubmers: []")).toThrow(/invalid/);
		expect(parseTelnyxEnvFile("").numbers).toEqual([]);
	});
});

describe("isHostname", () => {
	it("accepts a hostname and refuses what az prints for nothing", () => {
		expect(isHostname(HOST)).toBe(true);
		expect(isHostname("None")).toBe(false);
		expect(isHostname("")).toBe(false);
		expect(isHostname("https://x.example.com")).toBe(false);
	});
});

describe("desiredApplication", () => {
	it("points webhooks at the host, keeps first_command_timeout off and allows two lines", () => {
		expect(desiredApplication("dev", FILE, HOST)).toEqual({
			application_name: "pixel-phone-dev",
			webhook_event_url: `https://${HOST}/webhooks/telnyx`,
			webhook_event_failover_url: "",
			webhook_api_version: "2",
			first_command_timeout: false,
			active: true,
			channel_limit: 2,
		});
	});

	it("names the app after the env by default and sets a failover URL when given", () => {
		const desired = desiredApplication(
			"prod",
			{ numbers: [], failover_host: "b.example.com" },
			HOST,
		);
		expect(desired.application_name).toBe("pixel-phone-prod");
		expect(desired.webhook_event_failover_url).toBe("https://b.example.com/webhooks/telnyx");
	});
});

describe("applicationChanges", () => {
	const desired = desiredApplication("dev", FILE, HOST);

	it("treats null and empty failover URLs as the same", () => {
		const current = {
			id: "a",
			application_name: "pixel-phone-dev",
			webhook_event_url: desired.webhook_event_url,
			webhook_event_failover_url: null,
			webhook_api_version: "2",
			first_command_timeout: false,
			active: true,
			inbound: { channel_limit: 2 },
		};
		expect(applicationChanges(current, desired)).toEqual([]);
	});

	it("lists every field when the application doesn't exist", () => {
		const changes = applicationChanges(undefined, desired);
		expect(changes.map((c) => c.field)).toContain("webhook_event_url");
		expect(changes.every((c) => c.from === undefined)).toBe(true);
	});
});

describe("sync against a fake Telnyx", () => {
	it("creates the app and points the number, then changes nothing on a second run", async () => {
		const first = await makePlan(api, "dev", FILE, HOST);
		expect(hasChanges(first)).toBe(true);
		expect(formatPlan(first)).toContain("+ create Call Control application pixel-phone-dev");
		expect(formatPlan(first)).toContain(`~ point ${NUMBER} at pixel-phone-dev (now nothing)`);
		const id = await applyPlan(api, first);

		expect(fake.applications).toHaveLength(1);
		expect(fake.applications[0]).toMatchObject({
			webhook_event_url: `https://${HOST}/webhooks/telnyx`,
			first_command_timeout: false,
			inbound: { channel_limit: 2 },
		});
		expect(fake.numbers[0]?.connection_id).toBe(id);

		const writes = fake.requests.filter((r) => r.method !== "GET").length;
		const second = await makePlan(api, "dev", FILE, HOST);
		expect(hasChanges(second)).toBe(false);
		expect(formatPlan(second)).toContain("is up to date");
		expect(formatPlan(second)).toContain("already points at");
		await applyPlan(api, second);
		expect(fake.requests.filter((r) => r.method !== "GET").length).toBe(writes);
	});

	it("reports drift when someone changes the webhook URL in the portal, and repairs it", async () => {
		await applyPlan(api, await makePlan(api, "dev", FILE, HOST));
		const app = fake.applications[0];
		if (!app) throw new Error("no app");
		app.webhook_event_url = "https://somewhere-else.example.com/hook";
		app.inbound = { channel_limit: 2, sip_subdomain: "keep-me" };

		const drift = await makePlan(api, "dev", FILE, HOST);
		expect(hasChanges(drift)).toBe(true);
		expect(formatPlan(drift)).toContain(
			`webhook_event_url: "https://somewhere-else.example.com/hook" → "https://${HOST}/webhooks/telnyx"`,
		);

		await applyPlan(api, drift);
		expect(app.webhook_event_url).toBe(`https://${HOST}/webhooks/telnyx`);
		expect(app.inbound).toEqual({ channel_limit: 2, sip_subdomain: "keep-me" });
		expect(hasChanges(await makePlan(api, "dev", FILE, HOST))).toBe(false);
	});

	it("ignores apps whose name only contains ours, and refuses duplicates", async () => {
		fake.applications.push({ id: "old", application_name: "pixel-phone-dev-old" });
		const plan = await makePlan(api, "dev", FILE, HOST);
		expect(plan.application).toBeUndefined();
		expect(planProblems(plan)).toEqual([]);

		fake.applications.push(
			{ id: "x", application_name: "pixel-phone-dev" },
			{ id: "y", application_name: "pixel-phone-dev" },
		);
		expect(planProblems(await makePlan(api, "dev", FILE, HOST))[0]).toMatch(/2 applications/);
	});

	it("flags a number that isn't on the account", async () => {
		fake.numbers = [];
		const plan = await makePlan(api, "dev", FILE, HOST);
		expect(planProblems(plan)[0]).toMatch(/isn't a number on this Telnyx account/);
		expect(formatPlan(plan)).toContain(`! ${NUMBER} isn't on this Telnyx account`);
	});

	it("sends the key only as a bearer header, and never puts it in an error", async () => {
		await makePlan(api, "dev", FILE, HOST);
		expect(fake.requests.every((r) => r.authorization === `Bearer ${fake.apiKey}`)).toBe(true);
		expect(JSON.stringify(fake.requests.map((r) => [r.path, r.body]))).not.toContain(fake.apiKey);

		const wrong = new TelnyxAdminApi("KEYWRONG_not_real", fake.url);
		const error = await wrong.applicationsNamed("x").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TelnyxApiError);
		expect((error as TelnyxApiError).status).toBe(401);
		expect((error as Error).message).toMatch(/Authentication failed.*TELNYX_API_KEY/);
		expect((error as Error).message).not.toContain("KEYWRONG");
	});

	it("explains an unreachable API and a non-JSON error", async () => {
		const down = new TelnyxAdminApi(fake.apiKey, "http://127.0.0.1:1");
		await expect(down.number(NUMBER)).rejects.toThrow(/didn't reach Telnyx/);

		const html = new TelnyxAdminApi(
			fake.apiKey,
			fake.url,
			async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
		);
		await expect(html.number(NUMBER)).rejects.toThrow(/502 Bad Gateway/);
	});

	it("updates an existing app found by name", async () => {
		fake.applications.push({
			id: "existing",
			application_name: "pixel-phone-dev",
			webhook_event_url: "https://old.example.com/webhooks/telnyx",
			webhook_api_version: "2",
			first_command_timeout: true,
			active: true,
		});
		fake.numbers[0] = { id: "num-1", phone_number: NUMBER, connection_id: "existing" };
		const plan = await makePlan(api, "dev", FILE, HOST);
		expect(formatPlan(plan)).toContain("~ update application pixel-phone-dev (existing)");
		expect(formatPlan(plan)).toContain("first_command_timeout: true → false");
		expect(formatPlan(plan)).toContain("inbound.channel_limit: (none) → 2");
		expect(await applyPlan(api, plan)).toBe("existing");
		expect(fake.applications[0]).toMatchObject({ first_command_timeout: false });
	});
});

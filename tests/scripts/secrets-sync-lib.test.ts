import { describe, expect, it } from "vitest";
import type { SecretEntry } from "../../scripts/secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe as describeRow,
	envValue,
	isNotFound,
	localValues,
	newEnvFile,
	parseShown,
	phoneEnvOf,
	setEnvValues,
	toPull,
	toPush,
	wrongEnvFile,
} from "../../scripts/secrets-sync-lib.ts";

const entry = (vault: string, env: string): SecretEntry => ({
	vault,
	env,
	feature: "telnyx",
	description: "test",
});
const KEY = entry("telnyx-api-key", "TELNYX_API_KEY");
const PUB = entry("telnyx-public-key", "TELNYX_PUBLIC_KEY");
const DSN = entry("sentry-dsn", "SENTRY_DSN");
const HA = entry("home-assistant-token", "HOME_ASSISTANT_TOKEN");
const SECRET = "fake-value-not-a-real-key";

describe("localValues", () => {
	it("reads the manifest's variables and skips empty ones", () => {
		const values = localValues([KEY, PUB, DSN], `TELNYX_API_KEY=${SECRET}\nSENTRY_DSN=\nOTHER=x\n`);
		expect([...values]).toEqual([["telnyx-api-key", SECRET]]);
		expect(localValues([KEY], undefined).size).toBe(0);
	});
});

describe("compare, toPush, toPull and describe", () => {
	const rows = compare(
		[KEY, PUB, DSN, HA],
		new Map([
			["telnyx-api-key", "v-same-1"],
			["telnyx-public-key", "v-loc"],
			["sentry-dsn", "v-only-here"],
		]),
		new Map([
			["telnyx-api-key", "v-same-1"],
			["telnyx-public-key", "v-remote"],
			["home-assistant-token", "v-only-there"],
		]),
	);

	it("gives each secret a status", () => {
		expect(rows.map((r) => r.status)).toEqual(["same", "changed", "local-only", "remote-only"]);
		expect(compare([KEY], new Map(), new Map())[0]?.status).toBe("neither");
	});

	it("pushes changes and new values but never deletes, and pulls the other way", () => {
		expect(toPush(rows).map((r) => r.entry.vault)).toEqual(["telnyx-public-key", "sentry-dsn"]);
		expect(toPull(rows).map((r) => r.entry.vault)).toEqual([
			"telnyx-public-key",
			"home-assistant-token",
		]);
	});

	it("describes each row without its value", () => {
		const push = rows.map((r) => describeRow(r, "push"));
		const pull = rows.map((r) => describeRow(r, "pull"));
		for (const line of [...push, ...pull]) {
			for (const value of ["v-same-1", "v-loc", "v-remote", "v-only-here", "v-only-there"]) {
				expect(line).not.toContain(value);
			}
		}
		expect(push[1]).toBe(
			"  ~ telnyx-public-key (TELNYX_PUBLIC_KEY): changes (8 characters → 5 characters)",
		);
		expect(push[2]).toContain("new in Key Vault");
		expect(push[3]).toContain("a push never deletes");
		expect(pull[2]).toContain("only local");
		expect(pull[3]).toContain("new locally (12 characters)");
		expect(describeRow(compare([KEY], new Map(), new Map())[0] as never, "push")).toContain(
			"not set either side",
		);
		expect(push[0]).toContain("the same");
		expect(describeRow({ entry: KEY, status: "local-only", local: "x" }, "push")).toContain(
			"1 character)",
		);
	});
});

describe("env files", () => {
	it("quotes a value only when it must, and refuses one it can't write safely", () => {
		expect(envValue("A", "plain-value_1")).toBe("plain-value_1");
		expect(envValue("A", "has space")).toBe("'has space'");
		expect(envValue("A", "it's")).toBe(`"it's"`);
		expect(() => envValue("A", "two\nlines")).toThrow(/by hand/);
		expect(() => envValue("A", `it's "both"`)).toThrow(/by hand/);
	});

	it("replaces keys in place, drops later duplicates and appends new ones", () => {
		const text = "# comment\nTELNYX_API_KEY=old\nOTHER=1\nexport TELNYX_API_KEY=older\n";
		const updated = setEnvValues(
			text,
			new Map([
				["TELNYX_API_KEY", "new"],
				["SENTRY_DSN", "https://x@example.invalid/1"],
			]),
		);
		expect(updated).toBe(
			"# comment\nTELNYX_API_KEY=new\nOTHER=1\nSENTRY_DSN=https://x@example.invalid/1\n",
		);
		expect(setEnvValues("", new Map([["A", "1"]]))).toBe("A=1\n");
	});

	it("starts a new file that says which environment it's for", () => {
		expect(newEnvFile("dev")).toContain("PIXEL_PHONE_ENV=dev");
		expect(phoneEnvOf(newEnvFile("prod"))).toBe("prod");
		expect(phoneEnvOf(undefined)).toBeUndefined();
	});

	it("refuses to push a file that belongs to the other environment", () => {
		expect(wrongEnvFile("prod", "PIXEL_PHONE_ENV=dev\n")).toMatch(/Refusing/);
		expect(wrongEnvFile("dev", "PIXEL_PHONE_ENV=dev\n")).toBeUndefined();
		expect(wrongEnvFile("dev", "OTHER=1\n")).toBeUndefined();
	});
});

describe("az", () => {
	it("reads and writes the right vault, writing from a file so the value is never an argument", () => {
		expect(azShowArgs("dev", "sentry-dsn")).toEqual(
			expect.arrayContaining(["--vault-name", "pixel-phone-dev-kv", "--name", "sentry-dsn"]),
		);
		const set = azSetArgs("prod", DSN, "/tmp/x");
		expect(set).toEqual(
			expect.arrayContaining(["--vault-name", "pixel-phone-prod-kv", "--file", "/tmp/x"]),
		);
		expect(set).not.toContain("--value");
	});

	it("recognises a missing secret and parses a shown one", () => {
		expect(isNotFound("(SecretNotFound) A secret with (name/id) x was not found")).toBe(true);
		expect(isNotFound("Forbidden")).toBe(false);
		expect(parseShown('"abc"\n')).toBe("abc");
		expect(() => parseShown("42")).toThrow(/isn't text/);
	});
});

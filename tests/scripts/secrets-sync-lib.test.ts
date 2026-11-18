import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGETS } from "../../scripts/envs.ts";
import {
	type AppSecret,
	loadSecretsManifest,
	type ToolingSecret,
} from "../../scripts/secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe as describeRow,
	envValue,
	isFile,
	isNotFound,
	localFile,
	localValues,
	newEnvFile,
	parseShown,
	phoneEnvOf,
	redactTfvars,
	setEnvValues,
	stackVariables,
	syncedSecrets,
	tfvarsKeys,
	tfvarsProblems,
	toPull,
	toPush,
	wrongEnvFile,
} from "../../scripts/secrets-sync-lib.ts";

const entry = (vault: string, env: string): AppSecret => ({
	vault,
	group: "app",
	env,
	feature: "telnyx",
	description: "test",
});
const TFVARS: ToolingSecret = { vault: "terraform-tfvars", group: "tooling", description: "test" };
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

	it("reads a file secret from its file's text, and an empty or missing file as unset", () => {
		const tfvars = "telnyx_enabled = true\n";
		expect([...localValues([KEY, TFVARS], "", new Map([["terraform-tfvars", tfvars]]))]).toEqual([
			["terraform-tfvars", tfvars],
		]);
		expect(localValues([TFVARS], "", new Map([["terraform-tfvars", ""]])).size).toBe(0);
		expect(localValues([TFVARS], "").size).toBe(0);
	});
});

describe("syncedSecrets", () => {
	const manifest = loadSecretsManifest();

	it("syncs the app group for secrets-pull, and adds the tfvars for just pull", () => {
		const secrets = syncedSecrets(manifest).map((s) => s.vault);
		const all = syncedSecrets(manifest, "all").map((s) => s.vault);
		expect(secrets).not.toContain("terraform-tfvars");
		expect(all).toEqual([...secrets, "terraform-tfvars"]);
	});

	it("keeps the tfvars in the env's stack folder", () => {
		expect(isFile(TFVARS)).toBe(true);
		expect(isFile(KEY)).toBe(false);
		expect(localFile(TFVARS, "prod")).toBe("infra/envs/prod/terraform.tfvars");
		expect(() => localFile({ ...TFVARS, vault: "unknown" }, "dev")).toThrow(/no local file/);
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
		const push = rows.map((r) => describeRow(r, "push", "dev"));
		const pull = rows.map((r) => describeRow(r, "pull", "dev"));
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
		expect(describeRow(compare([KEY], new Map(), new Map())[0] as never, "push", "dev")).toContain(
			"not set either side",
		);
		expect(push[0]).toContain("the same");
		expect(describeRow({ entry: KEY, status: "local-only", local: "x" }, "push", "dev")).toContain(
			"1 character)",
		);
		expect(describeRow({ entry: TFVARS, status: "neither" }, "pull", "prod")).toBe(
			"  - terraform-tfvars (infra/envs/prod/terraform.tfvars): not set either side",
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

describe("tfvars", () => {
	const variables = stackVariables(`
variable "telnyx_enabled" {
  type    = bool
  default = false
}

variable "registry_password" {
  type      = string
  sensitive = true
}
`);

	it("reads a stack's variables and which are sensitive", () => {
		expect([...variables.all]).toEqual(["telnyx_enabled", "registry_password"]);
		expect([...variables.sensitive]).toEqual(["registry_password"]);
	});

	it("lists top-level keys, not commented-out ones or map entries", () => {
		const text = `telnyx_enabled = true\n# sentry_enabled = true\nmaintainers = {\n  someone = "id"\n}\n`;
		expect(tfvarsKeys(text)).toEqual(["telnyx_enabled", "maintainers"]);
	});

	it("hides a sensitive value, commented out or not, and leaves the rest", () => {
		const text = `telnyx_enabled = true\nregistry_password = "${SECRET}"\n# registry_password = "${SECRET}"\n`;
		const redacted = redactTfvars(text, variables.sensitive);
		expect(redacted).not.toContain(SECRET);
		expect(redacted).toContain("telnyx_enabled = true");
		expect(redacted).toContain("# registry_password = (secret, hidden)");
	});

	it("refuses a secret or an undeclared variable, naming the key but never the value", () => {
		const problems = tfvarsProblems(
			`telnyx_enabled = true\nregistry_password = "${SECRET}"\ncustom_domains = []\n`,
			"dev",
			variables,
		);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/registry_password, which is a secret.*secrets\.auto\.tfvars/);
		expect(problems[1]).toMatch(/custom_domains, which infra\/envs\/dev doesn't declare/);
		for (const problem of problems) expect(problem).not.toContain(SECRET);
		expect(tfvarsProblems("telnyx_enabled = true\n", "dev", variables)).toEqual([]);
	});

	it.each(TARGETS)("accepts %s's committed example, so copying it is a valid start", (target) => {
		const read = (file: string) => readFileSync(`infra/envs/${target}/${file}`, "utf8");
		expect(
			tfvarsProblems(
				read("terraform.example.tfvars"),
				target,
				stackVariables(read("variables.tf")),
			),
		).toEqual([]);
	});

	it("tells dev's file from prod's: prod's custom_domains isn't a dev variable", () => {
		const prodExample = readFileSync("infra/envs/prod/terraform.example.tfvars", "utf8");
		const devVariables = stackVariables(readFileSync("infra/envs/dev/variables.tf", "utf8"));
		expect(tfvarsProblems(prodExample, "dev", devVariables).join("\n")).toMatch(/custom_domains/);
	});
});

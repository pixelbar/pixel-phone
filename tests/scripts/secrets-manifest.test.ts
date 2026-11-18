import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
	appSecrets,
	loadSecretsManifest,
	parseSecretsManifest,
	SecretsManifestError,
} from "../../scripts/secrets-manifest.ts";

const read = (file: string) => readFileSync(file, "utf8");

const valid = `
version: 1
features:
  telnyx: Telnyx
secrets:
  - vault: telnyx-api-key
    group: app
    env: TELNYX_API_KEY
    feature: telnyx
    description: A key.
`;

const tooling = `${valid}
  - vault: terraform-tfvars
    group: tooling
    description: The settings.
`;

describe("parseSecretsManifest", () => {
	it("reads a valid manifest", () => {
		const manifest = parseSecretsManifest(valid);
		expect(manifest.secrets.map((s) => s.vault)).toEqual(["telnyx-api-key"]);
		expect(Object.keys(manifest.features)).toEqual(["telnyx"]);
	});

	it("refuses text that isn't YAML", () => {
		expect(() => parseSecretsManifest("a: [")).toThrow(/not valid YAML/);
	});

	it("refuses unknown keys and bad names, listing each problem", () => {
		const bad = valid
			.replace("telnyx-api-key", "Telnyx_Key")
			.replace("TELNYX_API_KEY", "telnyx")
			.replace("    description", "    value: oops\n    description");
		const error = (() => {
			try {
				parseSecretsManifest(bad);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error).toBeInstanceOf(SecretsManifestError);
		expect(error?.message).toMatch(/vault/);
		expect(error?.message).toMatch(/env/);
		expect(error?.message).toMatch(/Unrecognized key/i);
		expect(error?.message).not.toContain("oops");
	});

	it("refuses duplicates, undeclared features and unused features", () => {
		const twice =
			`${valid}  - vault: telnyx-api-key\n    group: app\n    env: TELNYX_API_KEY\n    feature: sentry\n    description: Again.\n`.replace(
				"  telnyx: Telnyx",
				"  telnyx: Telnyx\n  unused: Nothing uses this",
			);
		expect(() => parseSecretsManifest(twice)).toThrow(/listed twice/);
		expect(() => parseSecretsManifest(twice)).toThrow(/reuses the env TELNYX_API_KEY/);
		expect(() => parseSecretsManifest(twice)).toThrow(/"sentry", which isn't declared/);
		expect(() => parseSecretsManifest(twice)).toThrow(/"unused" has no secrets/);
	});

	it("reads a tooling entry, which has no env or feature, and leaves it out of appSecrets", () => {
		const manifest = parseSecretsManifest(tooling);
		expect(manifest.secrets.map((s) => s.vault)).toEqual(["telnyx-api-key", "terraform-tfvars"]);
		expect(appSecrets(manifest).map((s) => s.vault)).toEqual(["telnyx-api-key"]);
	});

	it("refuses an entry without a group, an app entry without env, and a tooling entry with one", () => {
		expect(() => parseSecretsManifest(valid.replace("    group: app\n", ""))).toThrow(/group/);
		expect(() => parseSecretsManifest(valid.replace("    env: TELNYX_API_KEY\n", ""))).toThrow(
			/env/,
		);
		expect(() =>
			parseSecretsManifest(
				tooling.replace("    group: tooling\n", "    group: tooling\n    env: X\n"),
			),
		).toThrow(/Unrecognized key/i);
	});

	it("says when the file can't be read", () => {
		expect(() => loadSecretsManifest("does/not/exist.yaml")).toThrow(/cannot read/);
	});
});

describe("infra/secrets.manifest.yaml agrees with everything that names a secret", () => {
	const manifest = loadSecretsManifest();

	it("is valid", () => {
		expect(manifest.secrets.length).toBeGreaterThan(0);
	});

	it("maps every feature to a condition in the Terraform module, and no others", () => {
		const locals = read("infra/modules/pixel-phone/locals.tf");
		const block = locals.match(/secret_features = \{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
		const terraformFeatures = [...block.matchAll(/^\s*([a-z][a-z0-9-]*)\s*=/gm)].map((m) => m[1]);
		expect([...terraformFeatures].sort()).toEqual(Object.keys(manifest.features).sort());
	});

	it("lists every app secret's variable in .env.example", () => {
		const example = parseEnv(read(".env.example"));
		for (const secret of appSecrets(manifest)) expect(secret.env in example, secret.env).toBe(true);
	});

	it("reads every app secret's variable in src/config.ts", () => {
		const config = read("src/config.ts");
		for (const secret of appSecrets(manifest))
			expect(config, secret.env).toMatch(new RegExp(`\\b${secret.env}:`));
	});

	it("describes every secret in the runbook", () => {
		const runbook = read("docs/runbook.md");
		for (const secret of manifest.secrets) {
			expect(runbook, secret.vault).toContain(`\`${secret.vault}\``);
			if (secret.group === "app") expect(runbook, secret.env).toContain(`\`${secret.env}\``);
		}
	});

	it("keeps Terraform to the app group", () => {
		expect(read("infra/modules/pixel-phone/locals.tf")).toMatch(/s if s\.group == "app"/);
	});

	it("has the dev stack's ringing entity on the harmless _dev helper", () => {
		const main = read("infra/envs/dev/main.tf");
		expect(main).toMatch(
			/home_assistant_ringing_entity\s*=\s*"input_boolean\.pixel_phone_ringing_dev"/,
		);
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENVS, parseTarget, TARGETS } from "../../scripts/envs.ts";

describe("envs", () => {
	it("parses dev and prod and nothing else", () => {
		expect(parseTarget("dev")).toBe("dev");
		expect(parseTarget("prod")).toBe("prod");
		expect(() => parseTarget("staging")).toThrow(/"staging"/);
		expect(() => parseTarget(undefined)).toThrow(/nothing/);
	});

	it.each(TARGETS)("matches what infra/envs/%s creates", (target) => {
		const stack = readFileSync(`infra/envs/${target}/main.tf`, "utf8");
		expect(stack).toContain(`environment              = "${target}"`);
		expect(stack).toContain(`resource_group_name      = "${ENVS[target].resourceGroup}"`);
		expect(stack).toContain(`key_vault_name           = "${ENVS[target].vault}"`);
		expect(stack).toContain(`storage_account_name     = "${ENVS[target].storageAccount}"`);
		expect(ENVS[target].app).toBe(`pixel-phone-${target}`);
		expect(ENVS[target].prod).toBe(target === "prod");
	});

	it("keeps each stack's state in its own container", () => {
		for (const target of TARGETS) {
			const backend = readFileSync(`infra/envs/${target}/backend.azurerm.example.hcl`, "utf8");
			expect(backend).toMatch(new RegExp(`container_name\\s*=\\s*"pixel-phone-${target}"`));
		}
	});

	it("rings the real siren only from prod", () => {
		const dev = readFileSync("infra/envs/dev/main.tf", "utf8");
		const prod = readFileSync("infra/envs/prod/main.tf", "utf8");
		expect(dev).toMatch(/home_assistant_ringing_entity = "input_boolean\.pixel_phone_ringing_dev"/);
		expect(prod).toMatch(/home_assistant_ringing_entity = "input_boolean\.pixel_phone_ringing"/);
		expect(prod).toMatch(/purge_protection_enabled = true/);
	});
});

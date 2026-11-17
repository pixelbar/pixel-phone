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

	it("matches what the Terraform stacks create", () => {
		const dev = readFileSync("infra/envs/dev/main.tf", "utf8");
		expect(dev).toContain(`resource_group_name      = "${ENVS.dev.resourceGroup}"`);
		expect(dev).toContain(`key_vault_name           = "${ENVS.dev.vault}"`);
		expect(dev).toContain(`storage_account_name     = "${ENVS.dev.storageAccount}"`);
		for (const target of TARGETS) expect(ENVS[target].prod).toBe(target === "prod");
	});
});

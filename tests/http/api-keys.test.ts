import { describe, expect, it } from "vitest";
import { newApiKeyLine } from "../../scripts/api-key.ts";
import { ApiKeys, parseApiKeys } from "../../src/http/api-keys.ts";

const K = "a".repeat(32);

describe("parseApiKeys", () => {
	it("reads the YAML list", () => {
		expect(
			parseApiKeys(`- { id: home-assistant, key: ${K} }\n- { id: pixel, key: ${"b".repeat(40)} }`),
		).toEqual([
			{ id: "home-assistant", key: K },
			{ id: "pixel", key: "b".repeat(40) },
		]);
	});

	it("refuses short keys, bad ids, duplicates and junk, without echoing a key", () => {
		const short = "short-secret";
		expect(() => parseApiKeys(`- { id: pixel, key: ${short} }`)).toThrow(/at least 32/);
		try {
			parseApiKeys(`- { id: pixel, key: ${short} }`);
		} catch (error) {
			expect((error as Error).message).not.toContain(short);
		}
		expect(() => parseApiKeys(`- { id: Pixel!, key: ${K} }`)).toThrow(/id must be/);
		expect(() =>
			parseApiKeys(`- { id: pixel, key: ${K} }\n- { id: pixel, key: ${"c".repeat(32)} }`),
		).toThrow(/twice/);
		expect(() => parseApiKeys(`- { id: a1, key: ${K} }\n- { id: b1, key: ${K} }`)).toThrow(
			/another caller/,
		);
		expect(() => parseApiKeys("[]")).toThrow(/invalid/);
		expect(() => parseApiKeys("- {")).toThrow(/valid YAML/);
	});
});

describe("ApiKeys", () => {
	const keys = new ApiKeys(parseApiKeys(`- { id: home-assistant, key: ${K} }`));
	it("identifies a bearer token, case-insensitively on the scheme", () => {
		expect(keys.identify(`Bearer ${K}`)).toBe("home-assistant");
		expect(keys.identify(`bearer ${K}`)).toBe("home-assistant");
		expect(keys.identify(`Bearer ${K}b`)).toBeUndefined();
		expect(keys.identify(K)).toBeUndefined();
		expect(keys.identify(undefined)).toBeUndefined();
	});
});

describe("just api-key", () => {
	it("prints a YAML line with a fresh 43-character key that parses", () => {
		const line = newApiKeyLine("home-assistant");
		expect(line).toMatch(/^- \{ id: home-assistant, key: [A-Za-z0-9_-]{43} \}$/);
		expect(parseApiKeys(line)[0]?.id).toBe("home-assistant");
		expect(newApiKeyLine("pixel")).not.toBe(newApiKeyLine("pixel"));
		expect(() => newApiKeyLine("Bad Id")).toThrow();
	});
});

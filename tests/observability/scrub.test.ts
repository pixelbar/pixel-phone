import { describe, expect, it } from "vitest";
import { scrubDeep, scrubString } from "../../src/observability/scrub.ts";

const TELNYX = `KEY${"0A".repeat(12)}_${"x".repeat(20)}`;
const JWT = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;

describe("scrubString", () => {
	it("masks token shapes and leaves phone numbers alone", () => {
		expect(scrubString(`key ${TELNYX} done`)).toBe("key [redacted-telnyx-key] done");
		expect(scrubString(`ha ${JWT}`)).toBe("ha [redacted-token]");
		expect(scrubString("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
		expect(scrubString("https://x.blob.core.windows.net/media/a.mp3?sv=1&sig=abc%2F&se=2")).toBe(
			"https://x.blob.core.windows.net/media/a.mp3?sv=1&sig=[redacted]&se=2",
		);
		expect(scrubString("from +31201234567")).toBe("from +31201234567");
	});

	it("keeps a serialized JSON log line valid", () => {
		const line = JSON.stringify({
			msg: 'sent "Bearer abc123" to https://x/y?sig=abc%2F" and "' + JWT + '"',
		});
		const scrubbed = scrubString(line);
		expect(JSON.parse(scrubbed)).toEqual({
			msg: 'sent "Bearer [redacted]" to https://x/y?sig=[redacted]" and "[redacted-token]"',
		});
	});

	it("scrubs a long run of eyJ in linear time", () => {
		const hostile = "eyJ".repeat(21_800); // about the 64 KB webhook body limit
		const started = performance.now();
		expect(scrubString(hostile)).toBe(hostile);
		// Quadratic matching took over two seconds here; linear takes a millisecond or two.
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("still finds a JWT after punctuation", () => {
		expect(scrubString(`token=${JWT}`)).toBe("token=[redacted-token]");
		expect(scrubString(`"${JWT}"`)).toBe('"[redacted-token]"');
	});
});

describe("scrubDeep", () => {
	it("copies objects, arrays and errors with every string scrubbed, cycles included", () => {
		const error = new Error(`failed with ${TELNYX}`, { cause: new Error(JWT) });
		const value: Record<string, unknown> = { list: [TELNYX, 1, null], error };
		value.self = value;
		const out = scrubDeep(value);
		expect(out.list).toEqual(["[redacted-telnyx-key]", 1, null]);
		expect(out.self).toBe(out);
		expect(out.error).toMatchObject({
			name: "Error",
			message: "failed with [redacted-telnyx-key]",
			cause: { message: "[redacted-token]" },
		});
		expect(JSON.stringify(out.error)).not.toContain(TELNYX);
		expect(value.list).toEqual([TELNYX, 1, null]);
	});
});

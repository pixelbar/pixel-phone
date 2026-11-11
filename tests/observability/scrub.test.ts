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

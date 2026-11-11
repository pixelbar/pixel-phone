import { describe, expect, it } from "vitest";
import { PixelPhoneError } from "../../src/core/errors.ts";

describe("PixelPhoneError", () => {
	it("is an Error with its own name", () => {
		const error = new PixelPhoneError("nope");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("PixelPhoneError");
		expect(error.message).toBe("nope");
	});
});

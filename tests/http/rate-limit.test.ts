import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/http/rate-limit.ts";

describe("RateLimiter", () => {
	it("allows the limit per window, per key, and forgets old windows", () => {
		let now = 0;
		const limiter = new RateLimiter(2, 1000, () => now);
		expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
		expect(limiter.take("b")).toBe(true);
		now = 1000;
		expect(limiter.take("a")).toBe(true);
		for (let i = 0; i < 1100; i++) limiter.take(`k${i}`);
		now = 5000;
		expect(limiter.take("fresh")).toBe(true);
	});
});

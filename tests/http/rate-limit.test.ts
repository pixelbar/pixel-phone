import { describe, expect, it } from "vitest";
import { MAX_KEYS, RateLimiter } from "../../src/http/rate-limit.ts";

describe("RateLimiter", () => {
	it("never tracks more than MAX_KEYS keys, dropping the oldest", () => {
		const limiter = new RateLimiter(1, 60_000, () => 0);
		for (let i = 0; i <= MAX_KEYS + 50; i++) limiter.take(`spoofed-${i}`);
		const size = (limiter as unknown as { windows: Map<string, unknown> }).windows.size;
		expect(size).toBe(MAX_KEYS);
		// The newest key is still limited; the oldest was forgotten.
		expect(limiter.take(`spoofed-${MAX_KEYS + 50}`)).toBe(false);
		expect(limiter.take("spoofed-0")).toBe(true);
	});

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

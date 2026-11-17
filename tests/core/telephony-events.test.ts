import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/telephony-events.ts";

describe("systemClock", () => {
	it("tells the time and runs timers, which can be cancelled", async () => {
		expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
		let fired = 0;
		systemClock.setTimer(1, () => fired++);
		const cancel = systemClock.setTimer(1, () => fired++);
		cancel();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fired).toBe(1);
	});
});

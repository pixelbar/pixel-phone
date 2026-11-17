import { describe, expect, it } from "vitest";
import { parseOptions, predictedOutcome, stamp } from "../../scripts/simulate-call-lib.ts";

describe("just simulate-call options", () => {
	it("has defaults and reads every option", () => {
		expect(parseOptions([])).toEqual({
			acceptVia: "home-assistant",
			secondCall: false,
			haDown: false,
			queueDown: false,
			window: 15,
			port: 3100,
		});
		expect(
			parseOptions([
				"--accept-after",
				"3",
				"--accept-via",
				"pixel",
				"--hangup-after",
				"9",
				"--second-call",
				"--ha-down",
				"--queue-down",
				"--window",
				"5",
				"--expect",
				"ended",
				"--port",
				"3200",
			]),
		).toEqual({
			acceptAfter: 3,
			acceptVia: "pixel",
			hangupAfter: 9,
			secondCall: true,
			haDown: true,
			queueDown: true,
			window: 5,
			expect: "ended",
			port: 3200,
		});
	});

	it("explains bad options", () => {
		expect(() => parseOptions(["--accept-after"])).toThrow(/needs a number/);
		expect(() => parseOptions(["--accept-after", "-1"])).toThrow(/needs a number/);
		expect(() => parseOptions(["--accept-via", "discord"])).toThrow(/pixel or home-assistant/);
		expect(() => parseOptions(["--window", "2"])).toThrow(/5 to 120/);
		expect(() => parseOptions(["--expect", "busy"])).toThrow(/ended or missed/);
		expect(() => parseOptions(["--port", "80"])).toThrow(/1024 to 65535/);
		expect(() => parseOptions(["--nope"])).toThrow(/Unknown option/);
		expect(() => parseOptions(["--help"])).toThrow(/just simulate-call/);
	});

	it("predicts the outcome", () => {
		const base = parseOptions([]);
		expect(predictedOutcome(base)).toBe("missed");
		expect(predictedOutcome({ ...base, acceptAfter: 3 })).toBe("ended");
		expect(predictedOutcome({ ...base, acceptAfter: 20 })).toBe("missed");
		expect(predictedOutcome({ ...base, acceptAfter: 5, hangupAfter: 2 })).toBe("missed");
		expect(predictedOutcome({ ...base, acceptAfter: 2, hangupAfter: 5 })).toBe("ended");
		expect(stamp(1234)).toBe("+  1.23s");
	});
});

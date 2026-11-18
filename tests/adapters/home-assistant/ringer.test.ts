import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HomeAssistantError,
	HomeAssistantRinger,
	NoRinger,
} from "../../../src/adapters/home-assistant/ringer.ts";
import {
	type FakeHomeAssistant,
	startFakeHomeAssistant,
} from "../../../src/testing/fake-home-assistant.ts";

const ENTITY = "input_boolean.pixel_phone_ringing_dev";
let ha: FakeHomeAssistant;
let ringer: HomeAssistantRinger;
beforeEach(async () => {
	ha = await startFakeHomeAssistant();
	ringer = new HomeAssistantRinger({
		url: `${ha.url}/`,
		token: ha.token,
		entityId: ENTITY,
		timeoutMs: 200,
	});
});
afterEach(() => ha.close());

describe("HomeAssistantRinger", () => {
	it("turns the helper on and off", async () => {
		await ringer.ringing(true);
		expect(ha.states.get(ENTITY)).toBe("on");
		await ringer.ringing(false);
		expect(ha.calls.map((c) => [c.service, c.entityId])).toEqual([
			["turn_on", ENTITY],
			["turn_off", ENTITY],
		]);
		expect(ha.states.get(ENTITY)).toBe("off");
	});

	it("fails on a timeout, without retrying", async () => {
		ha.mode = "hang";
		const started = Date.now();
		await expect(ringer.ringing(true)).rejects.toThrow(/didn't get through \(TimeoutError\)/);
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("fails on a 401 and a 5xx, naming the likely cause, never the token", async () => {
		const wrong = new HomeAssistantRinger({ url: ha.url, token: "nope-token", entityId: ENTITY });
		const error = await wrong.ringing(true).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HomeAssistantError);
		expect((error as Error).message).toMatch(/401 \(is HOME_ASSISTANT_TOKEN valid\?\)/);
		expect((error as Error).message).not.toContain("nope-token");
		ha.mode = 503;
		await expect(ringer.ringing(true)).rejects.toThrow(/failed: 503$/);
		ha.mode = 400;
		await expect(ringer.ringing(false)).rejects.toThrow(/does input_boolean/);
	});

	it("fails when the connection drops", async () => {
		ha.mode = "down";
		await expect(ringer.ringing(true)).rejects.toBeInstanceOf(HomeAssistantError);
	});
});

describe("NoRinger", () => {
	it("only logs", async () => {
		const log = vi.fn();
		await new NoRinger(log).ringing(true);
		expect(log).toHaveBeenCalledWith(true);
	});
});

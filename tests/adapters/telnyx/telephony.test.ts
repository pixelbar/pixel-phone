import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeClientState } from "../../../src/adapters/telnyx/client-state.ts";
import { TelnyxTelephony } from "../../../src/adapters/telnyx/telephony.ts";
import { CallGone, TelephonyFailed, TelephonyMisuse } from "../../../src/core/errors.ts";
import { type FakeTelnyxApi, startFakeTelnyxApi } from "../../../src/testing/fake-telnyx-api.ts";

let api: FakeTelnyxApi;
let telephony: TelnyxTelephony;
beforeEach(async () => {
	api = await startFakeTelnyxApi();
	telephony = new TelnyxTelephony({ apiKey: api.apiKey, baseUrl: api.url, timeoutMs: 300 });
});
afterEach(() => api.close());

const bodies = () => api.requests.map((r) => r.body as Record<string, string>);

describe("TelnyxTelephony", () => {
	it("sends answer, playback_start and hangup with a command_id and our call ID", async () => {
		await telephony.answer("v3:abc", "call-1");
		await telephony.play("v3:abc", "https://media.example/accepted.mp3?sig=x", "call-1");
		await telephony.hangup("v3:abc", "call-1");
		expect(api.requests.map((r) => r.path)).toEqual([
			"/v2/calls/v3%3Aabc/actions/answer",
			"/v2/calls/v3%3Aabc/actions/playback_start",
			"/v2/calls/v3%3Aabc/actions/hangup",
		]);
		expect(bodies()[1]?.audio_url).toBe("https://media.example/accepted.mp3?sig=x");
		for (const body of bodies()) {
			expect(body.command_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(decodeClientState(body.client_state)).toBe("call-1");
		}
		expect(new Set(bodies().map((b) => b.command_id)).size).toBe(3);
	});

	it("sends the key only in the Authorization header", async () => {
		await telephony.answer("v3:abc", "call-1");
		expect(api.requests[0]?.authorization).toBe(`Bearer ${api.apiKey}`);
		expect(JSON.stringify(bodies())).not.toContain(api.apiKey);
	});

	it("maps 90018 to CallGone and 90034 to TelephonyMisuse", async () => {
		api.commandReplies.push(
			{ status: 422, body: { errors: [{ code: "90018", title: "Call has already ended" }] } },
			{ status: 422, body: { errors: [{ code: 90034, title: "Call is not answered" }] } },
		);
		await expect(telephony.answer("v3:abc", "c")).rejects.toBeInstanceOf(CallGone);
		await expect(telephony.play("v3:abc", "u", "c")).rejects.toBeInstanceOf(TelephonyMisuse);
	});

	it("doesn't retry an HTTP error", async () => {
		api.commandReplies.push({ status: 500, body: "oops" }, { status: 200 });
		const error = await telephony.hangup("v3:abc", "c").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TelephonyFailed);
		expect((error as Error).message).toMatch(/500/);
		expect(api.requests).toHaveLength(1);
	});

	it("retries once, with the same command_id, after a network error or timeout", async () => {
		api.commandReplies.push("reset");
		await telephony.answer("v3:abc", "c");
		expect(api.requests).toHaveLength(2);
		expect(bodies()[0]?.command_id).toBe(bodies()[1]?.command_id);

		api.requests = [];
		api.commandReplies.push("hang", "hang");
		const started = Date.now();
		const error = await telephony.answer("v3:abc", "c").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TelephonyFailed);
		expect((error as Error).message).toMatch(/didn't get through/);
		expect(api.requests).toHaveLength(2);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("never puts the key in an error", async () => {
		const wrong = new TelnyxTelephony({ apiKey: "KEYWRONG_not_real", baseUrl: api.url });
		const error = await wrong.answer("v3:abc", "c").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TelephonyFailed);
		expect(String((error as Error).message)).toMatch(/401/);
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("KEYWRONG");
	});

	it("copes with an error body that isn't JSON", async () => {
		const html = new TelnyxTelephony({
			apiKey: "k",
			fetch: async () => new Response("<html>", { status: 502, statusText: "Bad Gateway" }),
		});
		await expect(html.answer("x", "c")).rejects.toThrow(/502 Bad Gateway/);
	});
});

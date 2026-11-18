import { afterEach, describe, expect, it } from "vitest";
import { MemoryCallStore } from "../../src/adapters/memory/call-store.ts";
import { CallFlow, type FailureArea } from "../../src/core/call-flow.ts";
import { CallGone, NoSuchCall, TelephonyFailed } from "../../src/core/errors.ts";
import type { TelephonyEvent } from "../../src/core/telephony-events.ts";
import { FakeClock, flush } from "../../src/testing/fake-clock.ts";
import { FakeMedia } from "../../src/testing/fake-media.ts";
import { FakePublisher } from "../../src/testing/fake-publisher.ts";
import { FakeRinger } from "../../src/testing/fake-ringer.ts";
import { FakeTelephony } from "../../src/testing/fake-telephony.ts";

const flows: CallFlow[] = [];
afterEach(() => {
	for (const f of flows.splice(0)) f.stop();
});

function setup() {
	const clock = new FakeClock();
	const store = new MemoryCallStore();
	const telephony = new FakeTelephony();
	const ringer = new FakeRinger();
	const publisher = new FakePublisher();
	const media = new FakeMedia();
	const logs: { event: string; fields: Record<string, unknown> }[] = [];
	const failures: { area: FailureArea; error: unknown; fields: Record<string, unknown> }[] = [];
	const flow = new CallFlow({
		store,
		clock,
		telephony,
		ringer,
		publisher,
		media,
		recording: "accepted.mp3",
		observer: {
			log: (event, fields) => logs.push({ event, fields }),
			fail: (area, error, fields) => failures.push({ area, error, fields }),
		},
	});
	telephony.handler = flow;
	flows.push(flow);
	let n = 0;
	const event = (
		type: TelephonyEvent["type"],
		callControlId: string,
		extra: Partial<TelephonyEvent> = {},
	) => flow.handle({ id: `e${++n}`, type, occurredAt: clock.now(), callControlId, ...extra });
	const ring = async (callControlId = "v3:door") => {
		await event("call.initiated", callControlId, {
			direction: "incoming",
			from: "+31201234567",
			to: "+31103024128",
		});
		await settle();
		return store.all().find((c) => c.callControlId === callControlId)?.callId ?? "";
	};
	const settle = async () => {
		await flush();
		await flow.idle();
		await flush();
	};
	const outcomes = () => logs.map((l) => l.event).filter((e) => e.startsWith("call."));
	const areas = () => failures.map((f) => f.area);
	return {
		clock,
		store,
		telephony,
		ringer,
		publisher,
		media,
		flow,
		logs,
		failures,
		event,
		ring,
		settle,
		outcomes,
		areas,
	};
}

describe("the call flow, end to end with fakes", () => {
	it("accepted by the button: answer, play, ringer off, accepted; then hang up and ended", async () => {
		const s = setup();
		const callId = await s.ring();
		expect(s.ringer.on).toBe(true);
		expect(s.publisher.types()).toEqual(["ringing"]);
		expect(s.telephony.commands).toEqual([]); // nothing until an accept (ADR 0002)

		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		expect(s.telephony.actions()).toEqual(["answer", "play"]);
		expect(s.telephony.commands[1]).toMatchObject({
			audioUrl: "https://media.test/accepted.mp3?sig=fake",
			callId,
		});
		expect(s.ringer.changes).toEqual([true, false]);
		expect(s.publisher.events[1]).toMatchObject({ type: "accepted", via: "home-assistant" });

		s.telephony.finishPlayback("v3:door", callId);
		await s.settle();
		expect(s.telephony.actions()).toEqual(["answer", "play", "hangup"]);
		expect(s.publisher.types()).toEqual(["ringing", "accepted", "ended"]);
		expect(s.store.all()[0]).toMatchObject({ status: "ended", endedReason: "playback_finished" });
		expect(s.outcomes()).toEqual([
			"call.ringing",
			"call.accepted",
			"call.answered_by_telnyx",
			"call.ended",
		]);
		const ended = s.logs.find((l) => l.event === "call.ended");
		expect(ended?.fields).toMatchObject({
			callId,
			from: "+31201234567",
			to: "+31103024128",
			via: "home-assistant",
		});
		expect(s.failures).toEqual([]);
	});

	it("accepted by Pixel, by call ID, recording who", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.flow.accept(callId, { via: "pixel", by: "discord:42" });
		await s.settle();
		expect(s.publisher.events[1]).toMatchObject({
			type: "accepted",
			via: "pixel",
			by: "discord:42",
		});
		expect(s.logs.find((l) => l.event === "call.accepted")?.fields).toMatchObject({
			via: "pixel",
			by: "discord:42",
		});
	});

	it("two near-simultaneous accepts: one winner, one answer", async () => {
		const s = setup();
		const callId = await s.ring();
		const results = await Promise.allSettled([
			s.flow.accept("current", { via: "home-assistant" }),
			s.flow.accept(callId, { via: "pixel", by: "discord:42" }),
		]);
		await s.settle();
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(s.telephony.actions().filter((a) => a === "answer")).toHaveLength(1);
		expect(s.publisher.types().filter((t) => t === "accepted")).toHaveLength(1);
	});

	it("timeout: no command, ringer off, missed", async () => {
		const s = setup();
		await s.ring();
		await s.clock.advance(15_000);
		await s.settle();
		expect(s.telephony.commands).toEqual([]);
		expect(s.ringer.changes).toEqual([true, false]);
		expect(s.publisher.events.at(-1)).toMatchObject({ type: "missed", reason: "timeout" });
		expect(s.outcomes()).toContain("call.missed");
		await expect(s.flow.accept("current", { via: "home-assistant" })).rejects.toBeInstanceOf(
			NoSuchCall,
		);
	});

	it("the caller hangs up while ringing: no command, ringer off, missed", async () => {
		const s = setup();
		await s.ring();
		await s.event("call.hangup", "v3:door", { hangupCause: "normal_clearing" });
		await s.settle();
		expect(s.telephony.commands).toEqual([]);
		expect(s.ringer.on).toBe(false);
		expect(s.publisher.events.at(-1)).toMatchObject({ type: "missed", reason: "caller_hung_up" });
	});

	it("a second call while one is active: busy, never answered, the first unaffected", async () => {
		const s = setup();
		const first = await s.ring("v3:one");
		await s.ring("v3:two");
		expect(s.publisher.events[1]).toMatchObject({ type: "busy", activeCallId: first });
		expect(s.ringer.changes).toEqual([true]);
		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		expect(s.telephony.commands.every((c) => c.callControlId === "v3:one")).toBe(true);
	});

	it("Home Assistant down: reported; Pixel still hears about it and can accept", async () => {
		const s = setup();
		s.ringer.fail = new Error("HA timeout");
		await s.ring();
		expect(s.publisher.types()).toEqual(["ringing"]);
		expect(s.areas()).toEqual(["home-assistant"]);
		await s.flow.accept("current", { via: "pixel" });
		await s.settle();
		expect(s.telephony.actions()).toEqual(["answer", "play"]);
	});

	it("queue down: reported; the ringer still rings", async () => {
		const s = setup();
		s.publisher.fail = new Error("queue down");
		await s.ring();
		expect(s.ringer.on).toBe(true);
		expect(s.areas()).toEqual(["queue"]);
	});

	it("both down: reported as such, and nothing is sent to Telnyx (it rings out)", async () => {
		const s = setup();
		s.ringer.fail = new Error("HA down");
		s.publisher.fail = new Error("queue down");
		await s.ring();
		expect(s.areas()).toEqual(["home-assistant", "queue", "call-flow"]);
		await s.clock.advance(15_000);
		await s.settle();
		expect(s.telephony.commands).toEqual([]);
		expect(s.store.all()[0]?.status).toBe("missed");
	});

	it("the caller is gone when we answer: missed, no play", async () => {
		const s = setup();
		await s.ring();
		s.telephony.failures.answer = [new CallGone("90018")];
		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		expect(s.telephony.actions()).toEqual(["answer"]);
		expect(s.store.all()[0]).toMatchObject({ status: "missed", missedReason: "caller_hung_up" });
		expect(s.publisher.types()).toEqual(["ringing", "accepted", "missed"]);
	});

	it("the caller hangs up during the recording: ended, no hang-up from us", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		s.telephony.callerHangsUp("v3:door", callId);
		await s.settle();
		expect(s.telephony.actions()).toEqual(["answer", "play"]);
		expect(s.publisher.events.at(-1)).toMatchObject({ type: "ended", reason: "caller_hung_up" });
	});

	it("answer fails for another reason: reported, the call is left to ring out", async () => {
		const s = setup();
		await s.ring();
		s.telephony.failures.answer = [new TelephonyFailed("500")];
		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		expect(s.areas()).toEqual(["telnyx"]);
		expect(s.telephony.actions()).toEqual(["answer"]);
	});

	it("the recording URL can't be signed, or play fails: reported, and we hang up", async () => {
		const a = setup();
		await a.ring();
		a.media.fail = new Error("no delegation key");
		await a.flow.accept("current", { via: "home-assistant" });
		await a.settle();
		expect(a.areas()).toEqual(["media"]);
		expect(a.telephony.actions()).toEqual(["answer", "hangup"]);

		const b = setup();
		await b.ring();
		b.telephony.failures.play = [new TelephonyFailed("422")];
		await b.flow.accept("current", { via: "home-assistant" });
		await b.settle();
		expect(b.areas()).toEqual(["telnyx"]);
		expect(b.telephony.actions()).toEqual(["answer", "play", "hangup"]);

		const c = setup();
		await c.ring();
		c.telephony.failures.play = [new CallGone("gone")];
		c.telephony.failures.hangup = [new TelephonyFailed("x")];
		await c.flow.accept("current", { via: "home-assistant" });
		await c.settle();
		expect(c.areas()).toEqual([]);
	});

	it("a hang-up that fails is reported; one on a gone call isn't", async () => {
		const s = setup();
		const callId = await s.ring();
		await s.flow.accept("current", { via: "home-assistant" });
		await s.settle();
		s.telephony.failures.hangup = [new TelephonyFailed("500")];
		s.telephony.finishPlayback("v3:door", callId);
		await s.settle();
		expect(s.areas()).toEqual(["telnyx"]);

		const t = setup();
		const id2 = await t.ring();
		await t.flow.accept("current", { via: "home-assistant" });
		await t.settle();
		t.telephony.failures.hangup = [new CallGone("gone")];
		t.telephony.finishPlayback("v3:door", id2);
		await t.settle();
		expect(t.areas()).toEqual([]);
	});

	it("a side effect that hangs is cut off by the time limit", async () => {
		const s = setup();
		s.ringer.ringing = () => new Promise(() => {});
		await s.event("call.initiated", "v3:door", { direction: "incoming" });
		await flush();
		await s.clock.advance(5_000);
		await s.settle();
		expect(s.areas()).toEqual(["home-assistant"]);
		expect(s.failures[0]?.error).toMatchObject({ name: "SideEffectTimeout" });
	});

	it("ignores outgoing calls", async () => {
		const s = setup();
		await s.event("call.initiated", "v3:out", { direction: "outgoing" });
		await s.settle();
		expect(s.store.all()).toEqual([]);
	});

	it("on start: recovers calls left ringing and warns when the recording is missing", async () => {
		const s = setup();
		await s.ring();
		s.flow.stop();
		await s.clock.advance(20_000);
		s.media.names.clear();
		await s.flow.start();
		await s.settle();
		expect(s.publisher.events.at(-1)).toMatchObject({ type: "missed", reason: "timeout" });
		expect(s.outcomes()).toContain("call.recovered");
		expect(s.failures.map((f) => [f.area, String(f.error)])).toEqual([
			["media", "Error: accept recording accepted.mp3 is missing"],
		]);
	});

	it("on start: storage or media being down is reported, not fatal", async () => {
		const s = setup();
		s.store.active = () => Promise.reject(new Error("table down"));
		s.media.exists = () => Promise.reject(new Error("blob down"));
		await s.flow.start();
		expect(s.areas()).toEqual(["storage", "media"]);
		const ok = setup();
		await ok.flow.start();
		expect(ok.failures).toEqual([]);
	});
});

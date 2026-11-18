/**
 * The Telnyx side of a call, for the local harness (#17): sends **signed** webhooks to the
 * app with a test key pair, receives Call Control commands on the fake API, and answers
 * each with the events real Telnyx would send (answer → call.answered, playback_start →
 * call.playback.ended a little later, hangup → call.hangup).
 */
import { type FakeTelnyxApi, startFakeTelnyxApi } from "./fake-telnyx-api.ts";
import { createTestSigner, type TestSigner, telnyxWebhookBody } from "./telnyx-signing.ts";

export type FakeTelnyxServer = {
	api: FakeTelnyxApi;
	signer: TestSigner;
	/** Sends a signed webhook to the app. Returns the HTTP status. */
	send(
		eventType: string,
		callControlId: string,
		payload?: Record<string, unknown>,
	): Promise<number>;
	/** Called for every webhook sent and command received, for the timeline. */
	onActivity: ((line: string) => void) | undefined;
	close(): Promise<void>;
};

export async function startFakeTelnyxServer(options: {
	webhookUrl: string;
	/** How long the recording "plays" before call.playback.ended. */
	playbackMs?: number;
}): Promise<FakeTelnyxServer> {
	const signer = createTestSigner();
	const api = await startFakeTelnyxApi();
	const timers = new Set<NodeJS.Timeout>();
	const server: FakeTelnyxServer = {
		api,
		signer,
		onActivity: undefined,
		async send(eventType, callControlId, payload = {}) {
			const body = telnyxWebhookBody(eventType, { call_control_id: callControlId, ...payload });
			const res = await fetch(options.webhookUrl, {
				method: "POST",
				headers: signer.headers(body),
				body,
			});
			await res.body?.cancel();
			server.onActivity?.(`telnyx → webhook ${eventType} (${callControlId}) → ${res.status}`);
			return res.status;
		},
		async close() {
			for (const t of timers) clearTimeout(t);
			await api.close();
		},
	};
	api.onCommand = (callControlId, action, body) => {
		server.onActivity?.(`telnyx ← command ${action} (${callControlId})`);
		const echo = typeof body.client_state === "string" ? { client_state: body.client_state } : {};
		const later = (ms: number, fn: () => void) => {
			const t = setTimeout(() => {
				timers.delete(t);
				fn();
			}, ms);
			timers.add(t);
		};
		if (action === "answer")
			later(50, () => void server.send("call.answered", callControlId, echo));
		if (action === "playback_start") {
			later(
				options.playbackMs ?? 2000,
				() => void server.send("call.playback.ended", callControlId, echo),
			);
		}
		if (action === "hangup") {
			later(
				50,
				() =>
					void server.send("call.hangup", callControlId, {
						...echo,
						hangup_cause: "normal_clearing",
					}),
			);
		}
	};
	return server;
}

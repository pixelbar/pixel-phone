/**
 * The Telephony port on Telnyx Call Control: `POST /v2/calls/{id}/actions/{action}`.
 *
 * - Every command carries a fresh `command_id`; Telnyx ignores a repeat with the same ID,
 *   so the single retry on a network error (or a timeout) can't run a command twice.
 * - No retry on any HTTP response: a 4xx won't get better, and a 5xx may have acted.
 * - `client_state` is our call ID, which Telnyx echoes back on the events it causes.
 * - The API key goes in the Authorization header and nowhere else.
 */
import { randomUUID } from "node:crypto";
import { CallGone, TelephonyFailed, TelephonyMisuse } from "../../core/errors.ts";
import type { Telephony } from "../../core/telephony.ts";
import { encodeClientState } from "./client-state.ts";

export const TELNYX_API = "https://api.telnyx.com";
export const COMMAND_TIMEOUT_MS = 5_000;

/** Telnyx error codes we treat specially. */
const CALL_ENDED = "90018";
const NOT_ANSWERED = "90034";

type Fetch = typeof globalThis.fetch;

export type TelnyxTelephonyOptions = {
	apiKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetch?: Fetch;
};

type Action = "answer" | "playback_start" | "hangup";

export class TelnyxTelephony implements Telephony {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: Fetch;

	constructor(options: TelnyxTelephonyOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl ?? TELNYX_API;
		this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	answer(callControlId: string, callId: string): Promise<void> {
		return this.command(callControlId, "answer", { client_state: encodeClientState(callId) });
	}

	play(callControlId: string, audioUrl: string, callId: string): Promise<void> {
		return this.command(callControlId, "playback_start", {
			audio_url: audioUrl,
			client_state: encodeClientState(callId),
		});
	}

	hangup(callControlId: string, callId: string): Promise<void> {
		return this.command(callControlId, "hangup", { client_state: encodeClientState(callId) });
	}

	private async command(
		callControlId: string,
		action: Action,
		body: Record<string, unknown>,
	): Promise<void> {
		const url = `${this.baseUrl}/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
		const init = {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ ...body, command_id: randomUUID() }),
		};
		let response: Response | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2 && response === undefined; attempt++) {
			try {
				response = await this.fetchImpl(url, {
					...init,
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch (error) {
				lastError = error;
			}
		}
		if (response === undefined) {
			const reason = lastError instanceof Error ? lastError.name : "error";
			throw new TelephonyFailed(`Telnyx ${action} didn't get through (${reason})`, {
				cause: lastError,
			});
		}
		if (response.ok) {
			await response.body?.cancel();
			return;
		}
		const { code, title } = await errorOf(response);
		const what = `Telnyx ${action} failed: ${response.status}${code ? ` ${code}` : ""} ${title}`;
		if (code === CALL_ENDED) throw new CallGone(what);
		if (code === NOT_ANSWERED) throw new TelephonyMisuse(what);
		throw new TelephonyFailed(what);
	}
}

async function errorOf(response: Response): Promise<{ code?: string; title: string }> {
	try {
		const parsed = (await response.json()) as {
			errors?: { code?: unknown; title?: unknown; detail?: unknown }[];
		};
		const first = parsed.errors?.[0];
		const code = first?.code === undefined ? undefined : String(first.code);
		const title = typeof first?.title === "string" ? first.title : response.statusText;
		return code === undefined ? { title } : { code, title };
	} catch {
		return { title: response.statusText };
	}
}

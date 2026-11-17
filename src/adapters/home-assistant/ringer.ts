/**
 * The Ringer on Home Assistant: `input_boolean.turn_on` / `turn_off` on the ringing
 * helper, through HA's REST API with a non-admin user's long-lived token. Three seconds,
 * no retry: a late siren is worse than a missing one, and the call rings out anyway.
 */
import type { Ringer } from "../../core/ringer.ts";

export const HOME_ASSISTANT_TIMEOUT_MS = 3_000;

type Fetch = typeof globalThis.fetch;

export class HomeAssistantError extends Error {
	override name = "HomeAssistantError";
}

export type HomeAssistantRingerOptions = {
	url: string;
	token: string;
	entityId: string;
	timeoutMs?: number;
	fetch?: Fetch;
};

export class HomeAssistantRinger implements Ringer {
	private readonly base: string;

	constructor(private readonly options: HomeAssistantRingerOptions) {
		this.base = options.url.replace(/\/+$/, "");
	}

	async ringing(on: boolean): Promise<void> {
		const service = on ? "turn_on" : "turn_off";
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await fetchImpl(`${this.base}/api/services/input_boolean/${service}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.options.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ entity_id: this.options.entityId }),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? HOME_ASSISTANT_TIMEOUT_MS),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.name : "error";
			throw new HomeAssistantError(`Home Assistant ${service} didn't get through (${reason})`, {
				cause: error,
			});
		}
		await response.body?.cancel();
		if (!response.ok) {
			const hint =
				response.status === 401
					? " (is HOME_ASSISTANT_TOKEN valid?)"
					: response.status === 400 || response.status === 404
						? ` (does ${this.options.entityId} exist, and may this user change it?)`
						: "";
			throw new HomeAssistantError(
				`Home Assistant ${service} ${this.options.entityId} failed: ${response.status}${hint}`,
			);
		}
	}
}

/** Used when Home Assistant isn't configured: logs instead of ringing. */
export class NoRinger implements Ringer {
	constructor(private readonly log: (on: boolean) => void) {}

	async ringing(on: boolean): Promise<void> {
		this.log(on);
	}
}

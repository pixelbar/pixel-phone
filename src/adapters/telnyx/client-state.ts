/**
 * Telnyx echoes a command's `client_state` back on the events it causes. We send our
 * call ID in it, as base64 JSON `{ "callId": "…" }`.
 */
import { z } from "zod";

const shape = z.object({ callId: z.string().min(1).max(100) });

export function encodeClientState(callId: string): string {
	return Buffer.from(JSON.stringify({ callId }), "utf8").toString("base64");
}

/** Our call ID, or undefined when the state is missing or isn't ours. */
export function decodeClientState(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const parsed = shape.safeParse(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
		return parsed.success ? parsed.data.callId : undefined;
	} catch {
		return undefined;
	}
}

/** `SeenEvents` in memory, for `just dev` without Azurite and for tests. Forgets on restart. */
import type { SeenEvents } from "../../core/telephony-events.ts";

export class MemorySeenEvents implements SeenEvents {
	private readonly seen = new Map<string, number>();

	async firstSeen(eventId: string, at: Date): Promise<boolean> {
		if (this.seen.has(eventId)) return false;
		this.seen.set(eventId, at.getTime());
		// Keep a day's worth; a webhook is never redelivered later than that.
		const cutoff = at.getTime() - 24 * 60 * 60 * 1000;
		for (const [id, time] of this.seen) if (time < cutoff) this.seen.delete(id);
		return true;
	}
}

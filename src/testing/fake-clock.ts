/** A Clock whose time only moves when a test says so. Timers fire as time passes them. */
import type { Clock } from "../core/telephony-events.ts";

type Timer = { at: number; fn: () => void; id: number };

export class FakeClock implements Clock {
	private time: number;
	private timers: Timer[] = [];
	private nextId = 0;

	constructor(start = new Date("2026-11-18T09:00:00.000Z")) {
		this.time = start.getTime();
	}

	now(): Date {
		return new Date(this.time);
	}

	setTimer(ms: number, fn: () => void): () => void {
		const id = this.nextId++;
		this.timers.push({ at: this.time + ms, fn, id });
		return () => {
			this.timers = this.timers.filter((t) => t.id !== id);
		};
	}

	/** Moves time forward, firing due timers in order. Awaits microtasks between them. */
	async advance(ms: number): Promise<void> {
		const end = this.time + ms;
		for (;;) {
			const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.timers = this.timers.filter((t) => t.id !== due.id);
			this.time = due.at;
			due.fn();
			await flush();
		}
		this.time = end;
		await flush();
	}

	get pendingTimers(): number {
		return this.timers.length;
	}
}

/** Lets queued promise callbacks run. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

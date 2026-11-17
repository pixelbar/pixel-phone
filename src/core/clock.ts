/** Time, for the core. The system clock in production; FakeClock in tests. */

/** Wall-clock time and timers, faked in tests. */
export interface Clock {
	now(): Date;
	/** Runs `fn` after `ms`. Returns a function that cancels it. */
	setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
	now: () => new Date(),
	setTimer(ms, fn) {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

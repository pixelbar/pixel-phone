/**
 * A small fixed-window rate limit per key, in memory. One replica (ADR 0003), so
 * in-memory is enough. It stops a stuck button or a loop from hammering the accept API.
 */
/** Most keys tracked at once. Beyond it the oldest windows go, so spoofed keys can't grow memory. */
export const MAX_KEYS = 10_000;

export class RateLimiter {
	private readonly windows = new Map<string, { start: number; count: number }>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		private readonly now: () => number = Date.now,
	) {}

	/** True if this request is allowed. */
	take(key: string): boolean {
		const now = this.now();
		const window = this.windows.get(key);
		if (!window || now - window.start >= this.windowMs) {
			this.windows.set(key, { start: now, count: 1 });
			if (this.windows.size > 1000) this.sweep(now);
			// Maps iterate in insertion order: the first keys are the oldest windows.
			for (const key of this.windows.keys()) {
				if (this.windows.size <= MAX_KEYS) break;
				this.windows.delete(key);
			}
			return true;
		}
		window.count++;
		return window.count <= this.limit;
	}

	private sweep(now: number) {
		for (const [key, w] of this.windows)
			if (now - w.start >= this.windowMs) this.windows.delete(key);
	}
}

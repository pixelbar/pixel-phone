/**
 * A small fixed-window rate limit per key, in memory. One replica (ADR 0003), so
 * in-memory is enough. It stops a stuck button or a loop from hammering the accept API.
 */
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

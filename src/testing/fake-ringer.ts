/** A Ringer that records what it was told, and can be made to fail. */
import type { Ringer } from "../core/ringer.ts";

export class FakeRinger implements Ringer {
	readonly changes: boolean[] = [];
	fail: Error | undefined;

	async ringing(on: boolean): Promise<void> {
		if (this.fail) throw this.fail;
		this.changes.push(on);
	}

	get on(): boolean {
		return this.changes.at(-1) ?? false;
	}
}

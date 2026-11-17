/** A Media that hands out predictable URLs. */
import type { Media } from "../core/media.ts";

export class FakeMedia implements Media {
	readonly names = new Set(["accepted.mp3"]);
	fail: Error | undefined;

	async urlFor(name: string): Promise<string> {
		if (this.fail) throw this.fail;
		return `https://media.test/${name}?sig=fake`;
	}

	async exists(name: string): Promise<boolean> {
		return this.names.has(name);
	}
}

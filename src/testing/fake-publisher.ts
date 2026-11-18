/** An EventPublisher that keeps what it was given, and can be made to fail. */
import { type EventPublisher, type PhoneEvent, phoneEvent } from "../core/events.ts";

export class FakePublisher implements EventPublisher {
	readonly events: PhoneEvent[] = [];
	fail: Error | undefined;

	async publish(event: PhoneEvent): Promise<void> {
		if (this.fail) throw this.fail;
		this.events.push(phoneEvent.parse(event));
	}

	types(): string[] {
		return this.events.map((e) => e.type);
	}
}

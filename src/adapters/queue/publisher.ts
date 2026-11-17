/**
 * The EventPublisher on an Azure Storage Queue (ADR 0006). Messages are plain JSON (no
 * base64), live five minutes, and each send has three seconds in total.
 */
import { QueueClient } from "@azure/storage-queue";
import {
	EVENT_TTL_SECONDS,
	type EventPublisher,
	type PhoneEvent,
	phoneEvent,
} from "../../core/events.ts";
import { azureCredential, type StorageTarget } from "../storage/clients.ts";

export const QUEUE_TIMEOUT_MS = 3_000;

export function queueClient(target: StorageTarget, queue: string): QueueClient {
	const options = { retryOptions: { maxTries: 2, tryTimeoutInMs: QUEUE_TIMEOUT_MS } };
	if (target.kind === "connection-string") {
		return new QueueClient(target.connectionString, queue, options);
	}
	return new QueueClient(
		`https://${target.account}.queue.core.windows.net/${queue}`,
		azureCredential(target.clientId),
		options,
	);
}

export class StorageQueuePublisher implements EventPublisher {
	constructor(
		private readonly queue: QueueClient,
		private readonly timeoutMs = QUEUE_TIMEOUT_MS,
	) {}

	async publish(event: PhoneEvent): Promise<void> {
		// Never send what the contract doesn't allow: Pixel would choke on it.
		const message = JSON.stringify(phoneEvent.parse(event));
		await this.queue.sendMessage(message, {
			messageTimeToLive: EVENT_TTL_SECONDS,
			abortSignal: AbortSignal.timeout(this.timeoutMs),
		});
	}
}

/** Used when no storage is configured: logs the event instead. */
export class LogPublisher implements EventPublisher {
	constructor(private readonly log: (event: PhoneEvent) => void) {}

	async publish(event: PhoneEvent): Promise<void> {
		this.log(phoneEvent.parse(event));
	}
}

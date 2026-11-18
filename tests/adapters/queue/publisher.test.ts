import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	LogPublisher,
	queueClient,
	StorageQueuePublisher,
} from "../../../src/adapters/queue/publisher.ts";
import { eventFor, type PhoneEvent } from "../../../src/core/events.ts";
import { AZURITE, azuriteUp, uniqueName } from "../../helpers/azurite.ts";

const call = {
	callId: "20261118-3f9a1c2b7d4e",
	callControlId: "v3:x",
	status: "ringing" as const,
	createdAt: new Date(),
	updatedAt: new Date(),
	acceptBy: new Date(Date.now() + 15_000),
};
const event = eventFor.ringing(call, new Date());

describe.skipIf(!azuriteUp)("StorageQueuePublisher (Azurite)", () => {
	const queue = queueClient(
		{ kind: "connection-string", connectionString: AZURITE },
		uniqueName("phone-events-"),
	);
	beforeAll(() => queue.create());
	afterAll(() => queue.delete());

	it("sends plain JSON that lives five minutes", async () => {
		await new StorageQueuePublisher(queue).publish(event);
		const { receivedMessageItems } = await queue.receiveMessages();
		const message = receivedMessageItems[0];
		expect(JSON.parse(message?.messageText ?? "")).toEqual(event);
		const ttl = (message?.expiresOn?.getTime() ?? 0) - (message?.insertedOn?.getTime() ?? 0);
		expect(ttl).toBe(300_000);
	});

	it("refuses an event outside the contract", async () => {
		const bad = { ...event, type: "rejected" } as unknown as PhoneEvent;
		await expect(new StorageQueuePublisher(queue).publish(bad)).rejects.toThrow();
	});
});

describe("StorageQueuePublisher without a queue", () => {
	it("fails within three seconds when the queue can't be reached", async () => {
		const unreachable = queueClient(
			{
				kind: "connection-string",
				connectionString:
					"DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;QueueEndpoint=http://10.255.255.1:10001/devstoreaccount1;",
			},
			"phone-events",
		);
		const started = Date.now();
		await expect(new StorageQueuePublisher(unreachable, 500).publish(event)).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("builds an Azure client from the account name", () => {
		expect(queueClient({ kind: "azure", account: "pixelphonedevst" }, "phone-events").url).toBe(
			"https://pixelphonedevst.queue.core.windows.net/phone-events",
		);
	});
});

describe("LogPublisher", () => {
	it("logs valid events", async () => {
		const log = vi.fn();
		await new LogPublisher(log).publish(event);
		expect(log).toHaveBeenCalledWith(event);
	});
});

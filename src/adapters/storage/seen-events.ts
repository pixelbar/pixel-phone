/**
 * `SeenEvents` in the `WebhookEvents` table: one row per Telnyx event ID, partitioned by
 * UTC day, written with a conditional insert. Rows older than two days are pruned.
 */
import { randomUUID } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import type { SeenEvents } from "../../core/telephony-events.ts";
import { isStatus } from "./clients.ts";

export const WEBHOOK_EVENTS_TABLE = "WebhookEvents";
const TIMEOUT_MS = 3_000;

export const dayKey = (at: Date) => at.toISOString().slice(0, 10);

/** Table row keys can't hold / \ # ? or control characters. Telnyx IDs are UUIDs; be safe. */
export function safeRowKey(id: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
	return id.replace(/[/\\#?\u0000-\u001f\u007f-\u009f]/g, "_").slice(0, 512);
}

export class TableSeenEvents implements SeenEvents {
	constructor(private readonly table: TableClient) {}

	async firstSeen(eventId: string, at: Date): Promise<boolean> {
		const partitionKey = dayKey(at);
		const rowKey = safeRowKey(eventId);
		// The SDK retries on network errors. If our insert landed but its reply was lost, the
		// retry gets 409; the nonce tells our own write apart from a real duplicate.
		const nonce = randomUUID();
		try {
			await this.table.createEntity(
				{ partitionKey, rowKey, nonce },
				{ abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
			);
			return true;
		} catch (error) {
			if (!isStatus(error, 409)) throw error;
			const existing = await this.table.getEntity<{ nonce?: string }>(partitionKey, rowKey, {
				abortSignal: AbortSignal.timeout(TIMEOUT_MS),
			});
			return existing.nonce === nonce;
		}
	}

	/** Deletes rows from days before `before`'s day. Returns how many went. */
	async prune(before: Date): Promise<number> {
		const cutoff = dayKey(before);
		let deleted = 0;
		const rows = this.table.listEntities({
			queryOptions: { filter: `PartitionKey lt '${cutoff}'`, select: ["PartitionKey", "RowKey"] },
		});
		for await (const row of rows) {
			await this.table.deleteEntity(row.partitionKey as string, row.rowKey as string);
			deleted++;
		}
		return deleted;
	}
}

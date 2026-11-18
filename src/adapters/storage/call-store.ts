/**
 * `CallStore` in the `Calls` table (ADR 0004): partition = the UTC day the call started
 * (also the first part of the call ID), row = call ID. Updates are conditional on the
 * row's ETag. Rows are kept 90 days; `prune` deletes older ones.
 */
import { odata, type TableClient, type TableEntityResult } from "@azure/data-tables";
import {
	type Acceptor,
	CALL_ID_PATTERN,
	CALL_STATUSES,
	type Call,
	type CallStatus,
	type CallStore,
	type EndedReason,
	type MissedReason,
	type Versioned,
} from "../../core/calls.ts";
import { StoreConflict } from "../../core/errors.ts";
import { isStatus } from "./clients.ts";

export const CALLS_TABLE = "Calls";
export const CALL_RETENTION_DAYS = 90;
const TIMEOUT_MS = 3_000;

type CallEntity = {
	partitionKey: string;
	rowKey: string;
	callControlId: string;
	callSessionId?: string;
	from?: string;
	to?: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	acceptBy: string;
	acceptedVia?: string;
	acceptedByPerson?: string;
	acceptedAt?: string;
	missedReason?: string;
	endedReason?: string;
	endedAt?: string;
};

/** "20261118-…" → "2026-11-18". */
export function partitionOf(callId: string): string {
	return `${callId.slice(0, 4)}-${callId.slice(4, 6)}-${callId.slice(6, 8)}`;
}

const dayKey = (at: Date) => at.toISOString().slice(0, 10);
const opts = () => ({ abortSignal: AbortSignal.timeout(TIMEOUT_MS) });

export function toEntity(call: Call): CallEntity {
	const entity: CallEntity = {
		partitionKey: partitionOf(call.callId),
		rowKey: call.callId,
		callControlId: call.callControlId,
		status: call.status,
		createdAt: call.createdAt.toISOString(),
		updatedAt: call.updatedAt.toISOString(),
		acceptBy: call.acceptBy.toISOString(),
	};
	if (call.callSessionId) entity.callSessionId = call.callSessionId;
	if (call.from) entity.from = call.from;
	if (call.to) entity.to = call.to;
	if (call.acceptedBy) {
		entity.acceptedVia = call.acceptedBy.via;
		if (call.acceptedBy.by) entity.acceptedByPerson = call.acceptedBy.by;
	}
	if (call.acceptedAt) entity.acceptedAt = call.acceptedAt.toISOString();
	if (call.missedReason) entity.missedReason = call.missedReason;
	if (call.endedReason) entity.endedReason = call.endedReason;
	if (call.endedAt) entity.endedAt = call.endedAt.toISOString();
	return entity;
}

export function fromEntity(entity: CallEntity): Call {
	if (!(CALL_STATUSES as readonly string[]).includes(entity.status)) {
		throw new Error(`call ${entity.rowKey} has unknown status ${entity.status}`);
	}
	const acceptedBy: Acceptor | undefined = entity.acceptedVia
		? {
				via: entity.acceptedVia,
				...(entity.acceptedByPerson ? { by: entity.acceptedByPerson } : {}),
			}
		: undefined;
	return {
		callId: entity.rowKey,
		callControlId: entity.callControlId,
		...(entity.callSessionId ? { callSessionId: entity.callSessionId } : {}),
		...(entity.from ? { from: entity.from } : {}),
		...(entity.to ? { to: entity.to } : {}),
		status: entity.status as CallStatus,
		createdAt: new Date(entity.createdAt),
		updatedAt: new Date(entity.updatedAt),
		acceptBy: new Date(entity.acceptBy),
		...(acceptedBy ? { acceptedBy } : {}),
		...(entity.acceptedAt ? { acceptedAt: new Date(entity.acceptedAt) } : {}),
		...(entity.missedReason ? { missedReason: entity.missedReason as MissedReason } : {}),
		...(entity.endedReason ? { endedReason: entity.endedReason as EndedReason } : {}),
		...(entity.endedAt ? { endedAt: new Date(entity.endedAt) } : {}),
	};
}

const versioned = (e: TableEntityResult<CallEntity>): Versioned<Call> => ({
	value: fromEntity(e),
	etag: e.etag,
});

export class TableCallStore implements CallStore {
	constructor(
		private readonly table: TableClient,
		private readonly now: () => Date = () => new Date(),
	) {}

	async create(call: Call): Promise<string> {
		try {
			const result = await this.table.createEntity(toEntity(call), opts());
			return result.etag ?? "";
		} catch (error) {
			if (isStatus(error, 409)) throw new StoreConflict(`call ${call.callId} exists`);
			throw error;
		}
	}

	async get(callId: string): Promise<Versioned<Call> | undefined> {
		if (!CALL_ID_PATTERN.test(callId)) return undefined;
		try {
			return versioned(await this.table.getEntity<CallEntity>(partitionOf(callId), callId, opts()));
		} catch (error) {
			if (isStatus(error, 404)) return undefined;
			throw error;
		}
	}

	async findByControlId(callControlId: string): Promise<Versioned<Call> | undefined> {
		const since = dayKey(new Date(this.now().getTime() - 86_400_000));
		const filter = odata`PartitionKey ge ${since} and callControlId eq ${callControlId}`;
		for await (const entity of this.table.listEntities<CallEntity>({
			queryOptions: { filter },
			// A stalled listing would hold up every call change queued behind it.
			...opts(),
		})) {
			return versioned(entity);
		}
		return undefined;
	}

	async active(): Promise<Versioned<Call>[]> {
		const since = dayKey(new Date(this.now().getTime() - 2 * 86_400_000));
		const filter = odata`PartitionKey ge ${since} and (status eq ${"ringing"} or status eq ${"accepting"})`;
		const out: Versioned<Call>[] = [];
		for await (const entity of this.table.listEntities<CallEntity>({
			queryOptions: { filter },
			// A stalled listing would hold up every call change queued behind it.
			...opts(),
		})) {
			out.push(versioned(entity));
		}
		return out;
	}

	async update(call: Call, etag: string): Promise<string> {
		try {
			const result = await this.table.updateEntity(toEntity(call), "Replace", {
				etag,
				...opts(),
			});
			return result.etag ?? "";
		} catch (error) {
			if (isStatus(error, 412) || isStatus(error, 404)) {
				throw new StoreConflict(`call ${call.callId} changed`);
			}
			throw error;
		}
	}

	/** Deletes calls from days before `before`'s day. Returns how many went. */
	async prune(before: Date): Promise<number> {
		const filter = odata`PartitionKey lt ${dayKey(before)}`;
		let deleted = 0;
		for await (const row of this.table.listEntities({
			queryOptions: { filter, select: ["PartitionKey", "RowKey"] },
			abortSignal: AbortSignal.timeout(60_000),
		})) {
			await this.table.deleteEntity(row.partitionKey as string, row.rowKey as string);
			deleted++;
		}
		return deleted;
	}
}

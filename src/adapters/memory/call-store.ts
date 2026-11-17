/** `CallStore` in memory, for `just dev` without Azurite and for tests. Forgets on restart. */
import { type Call, type CallStore, isActive, type Versioned } from "../../core/calls.ts";
import { StoreConflict } from "../../core/errors.ts";

export class MemoryCallStore implements CallStore {
	private readonly rows = new Map<string, { call: Call; version: number }>();
	/** Called before each update, so a test can change the row underneath (a race). */
	beforeUpdate: ((call: Call) => void) | undefined;
	/** Writes land, but the next create/update reply is "lost": it throws StoreConflict. */
	loseNextReply = false;

	private lost(callId: string) {
		if (!this.loseNextReply) return;
		this.loseNextReply = false;
		throw new StoreConflict(`call ${callId}: reply lost, retry conflicted`);
	}

	async create(call: Call): Promise<string> {
		if (this.rows.has(call.callId)) throw new StoreConflict(`call ${call.callId} exists`);
		this.rows.set(call.callId, { call: structuredClone(call), version: 1 });
		this.lost(call.callId);
		return "1";
	}

	async get(callId: string): Promise<Versioned<Call> | undefined> {
		const row = this.rows.get(callId);
		return row && { value: structuredClone(row.call), etag: String(row.version) };
	}

	async findByControlId(callControlId: string): Promise<Versioned<Call> | undefined> {
		for (const row of this.rows.values()) {
			if (row.call.callControlId === callControlId) {
				return { value: structuredClone(row.call), etag: String(row.version) };
			}
		}
		return undefined;
	}

	async active(): Promise<Versioned<Call>[]> {
		return [...this.rows.values()]
			.filter((row) => isActive(row.call))
			.map((row) => ({ value: structuredClone(row.call), etag: String(row.version) }));
	}

	async update(call: Call, etag: string): Promise<string> {
		this.beforeUpdate?.(call);
		const row = this.rows.get(call.callId);
		if (!row || String(row.version) !== etag)
			throw new StoreConflict(`call ${call.callId} changed`);
		row.call = structuredClone(call);
		row.version++;
		this.lost(call.callId);
		return String(row.version);
	}

	/** Every call, oldest first. For tests and the harness. */
	all(): Call[] {
		return [...this.rows.values()]
			.map((row) => structuredClone(row.call))
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	}
}

/**
 * A doorbell call as pixel-phone tracks it (ADR 0004), and the port that stores it.
 * See the README's state diagram.
 */
import { randomBytes } from "node:crypto";

export const CALL_STATUSES = ["ringing", "accepting", "ended", "missed", "busy"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export type MissedReason = "timeout" | "caller_hung_up";
/** `abandoned`: accepted, but no playback or hang-up event came within minutes (ACCEPTING_MAX_MS). */
export type EndedReason = "playback_finished" | "caller_hung_up" | "abandoned";

/** Who accepted: `via` is the API key's ID (home-assistant, pixel), `by` an optional person. */
export type Acceptor = { via: string; by?: string };

export type Call = {
	callId: string;
	callControlId: string;
	callSessionId?: string;
	from?: string;
	to?: string;
	status: CallStatus;
	createdAt: Date;
	updatedAt: Date;
	/** When the accept window closes. */
	acceptBy: Date;
	acceptedBy?: Acceptor;
	acceptedAt?: Date;
	missedReason?: MissedReason;
	endedReason?: EndedReason;
	endedAt?: Date;
};

/** A stored value and the version it was read at, for conditional updates. */
export type Versioned<T> = { value: T; etag: string };

/**
 * Where calls live. Updates are conditional on the ETag and throw `StoreConflict` when
 * the row changed in between.
 */
export interface CallStore {
	create(call: Call): Promise<string>;
	get(callId: string): Promise<Versioned<Call> | undefined>;
	findByControlId(callControlId: string): Promise<Versioned<Call> | undefined>;
	/** Calls still `ringing` or `accepting`, from the last two days. */
	active(): Promise<Versioned<Call>[]>;
	update(call: Call, etag: string): Promise<string>;
}

/**
 * Our call ID: the UTC day it started, then random hex, e.g. `20261118-3f9a1c2b7d4e`.
 * The day is the Table storage partition, so a call can be found by its ID alone.
 */
export function newCallId(at: Date): string {
	const day = at.toISOString().slice(0, 10).replaceAll("-", "");
	return `${day}-${randomBytes(6).toString("hex")}`;
}

export const CALL_ID_PATTERN = /^\d{8}-[0-9a-f]{12}$/;

export const isActive = (call: Call) => call.status === "ringing" || call.status === "accepting";

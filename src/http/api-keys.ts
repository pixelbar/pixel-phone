/**
 * The accept API's callers (`API_KEYS_YAML`): a YAML list of `{ id, key }`, e.g.
 * `home-assistant` and `pixel`. The `id` is recorded as `via`; the key is a bearer token.
 *
 * Keys are compared in constant time, against every configured key (so the time taken
 * doesn't say which key nearly matched). Keys never reach a log or an error.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";

export const MIN_KEY_LENGTH = 32;

const entry = z.strictObject({
	id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, {
		error: "id must be lowercase letters, digits and dashes",
	}),
	key: z
		.string()
		.min(MIN_KEY_LENGTH, { error: `key must be at least ${MIN_KEY_LENGTH} characters` }),
});

export type ApiKey = z.infer<typeof entry>;

/** Parses and checks `API_KEYS_YAML`. Problems name the entry, never the key. */
export function parseApiKeys(yaml: string): ApiKey[] {
	let raw: unknown;
	try {
		raw = parse(yaml);
	} catch {
		throw new Error("API_KEYS_YAML isn't valid YAML");
	}
	const result = z.array(entry).min(1).safeParse(raw);
	if (!result.success) {
		const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		throw new Error(`API_KEYS_YAML is invalid: ${problems.join("; ")}`);
	}
	const ids = new Set<string>();
	const keys = new Set<string>();
	for (const { id, key } of result.data) {
		if (ids.has(id)) throw new Error(`API_KEYS_YAML lists ${id} twice`);
		if (keys.has(key)) throw new Error(`API_KEYS_YAML gives ${id} a key another caller has`);
		ids.add(id);
		keys.add(key);
	}
	return result.data;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Finds who a bearer token belongs to. */
export class ApiKeys {
	private readonly digests: { id: string; digest: Buffer }[];

	constructor(keys: readonly ApiKey[]) {
		this.digests = keys.map(({ id, key }) => ({ id, digest: digest(key) }));
	}

	/** The caller's ID for an `Authorization` header, or undefined. */
	identify(authorization: string | undefined): string | undefined {
		const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
		// Hash even a missing token so every request does the same work.
		const presented = digest(match?.[1] ?? "");
		let found: string | undefined;
		for (const { id, digest: expected } of this.digests) {
			if (timingSafeEqual(presented, expected) && match) found ??= id;
		}
		return found;
	}
}

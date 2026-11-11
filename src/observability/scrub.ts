/**
 * Redacts secrets from strings before they leave the process (log lines and Sentry
 * events). Defence in depth: code shouldn't log these in the first place. Phone
 * numbers are deliberately NOT redacted (ADR 0009).
 */

const PATTERNS: readonly [RegExp, string][] = [
	// Telnyx v2 API keys: KEY<hex>_<random>.
	[/KEY[0-9A-Fa-f]{16,}_[A-Za-z0-9]{8,}/g, "[redacted-telnyx-key]"],
	// Home Assistant long-lived tokens are JWTs: three base64url parts, the first starting "eyJ".
	[/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted-token]"],
	// A bearer credential in a header or message.
	[/(Bearer\s+)[^\s"',]+/gi, "$1[redacted]"],
	// The signature of a SAS URL: anyone holding it can read the blob until it expires.
	[/([?&]sig=)[^&\s"'<>]+/gi, "$1[redacted]"],
];

export function scrubString(input: string): string {
	let out = input;
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/**
 * Deep-copies `value`, scrubbing every string inside it. An object referenced more
 * than once (or in a cycle) is scrubbed once and its copy reused. An `Error` becomes
 * a plain object with its `name`, `message`, `stack`, `cause` and own fields.
 */
export function scrubDeep<T>(value: T): T {
	return scrubValue(value, new WeakMap()) as T;
}

function scrubValue(value: unknown, copies: WeakMap<object, unknown>): unknown {
	if (typeof value === "string") return scrubString(value);
	if (value === null || typeof value !== "object") return value;
	const copied = copies.get(value);
	if (copied !== undefined) return copied;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		copies.set(value, out);
		for (const item of value) out.push(scrubValue(item, copies));
		return out;
	}
	const out: Record<string, unknown> = {};
	copies.set(value, out);
	if (value instanceof Error) {
		out.name = scrubString(value.name);
		out.message = scrubString(value.message);
		if (value.stack !== undefined) out.stack = scrubString(value.stack);
		if (value.cause !== undefined) out.cause = scrubValue(value.cause, copies);
	}
	for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, copies);
	return out;
}

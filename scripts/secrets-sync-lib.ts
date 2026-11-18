/**
 * The pure half of `just pull` / `just push` and `just secrets-pull` / `secrets-push`:
 * lining local values up with Key Vault, describing the difference without ever showing
 * a secret value, editing env files, checking the shared tfvars, and the `az` arguments.
 * `scripts/secrets-sync.ts` does the reading and writing. Adapted from Pixel's
 * scripts/secrets-sync-lib.ts.
 */
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ENVS, type Target } from "./envs.ts";
import type { SecretEntry, SecretsManifest } from "./secrets-manifest.ts";

export type Values = ReadonlyMap<string, string>;

/** The Key Vault secret that holds the stack's terraform.tfvars. */
export const TFVARS_SECRET = "terraform-tfvars";

/** The stack's settings, shared through `terraform-tfvars`. Gitignored (`*.tfvars`). */
export function tfvarsFile(target: Target): string {
	return join("infra", "envs", target, "terraform.tfvars");
}

/** Where a secret Terraform input would go instead: auto-loaded, gitignored, never synced. */
export function secretTfvarsFile(target: Target): string {
	return join("infra", "envs", target, "secrets.auto.tfvars");
}

/** The local file behind each tooling secret. */
const FILES: Readonly<Record<string, (target: Target) => string>> = {
	[TFVARS_SECRET]: tfvarsFile,
};

/** Whether a secret is a whole local file (shown as a diff) rather than one env variable. */
export function isFile(entry: SecretEntry): boolean {
	return entry.group === "tooling";
}

export function localFile(entry: SecretEntry, target: Target): string {
	const file = FILES[entry.vault];
	if (!file) throw new Error(`${entry.vault} has no local file`); // syncedSecrets skips those
	return file(target);
}

/**
 * What the sync manages. `secrets` is the manifest's `app` group (`just secrets-pull`);
 * `all` adds the `tooling` group, which is the stack's tfvars (`just pull`).
 */
export function syncedSecrets(
	manifest: SecretsManifest,
	scope: "secrets" | "all" = "secrets",
): SecretEntry[] {
	return manifest.secrets.filter((s) => s.group === "app" || (scope === "all" && s.vault in FILES));
}

/**
 * Reads the managed secrets out of an env file's text and each file secret's text,
 * keyed by Key Vault name. Missing or empty means not set.
 */
export function localValues(
	entries: readonly SecretEntry[],
	envText: string | undefined,
	files: ReadonlyMap<string, string | undefined> = new Map(),
): Map<string, string> {
	const env = envText === undefined ? {} : parseEnv(envText);
	const out = new Map<string, string>();
	for (const entry of entries) {
		const value = entry.group === "app" ? env[entry.env] : files.get(entry.vault);
		if (value !== undefined && value !== "") out.set(entry.vault, value);
	}
	return out;
}

export type RowStatus = "same" | "changed" | "local-only" | "remote-only" | "neither";
export type Row = { entry: SecretEntry; local?: string; remote?: string; status: RowStatus };

/** Lines the local values up with what Key Vault has, one row per secret. */
export function compare(entries: readonly SecretEntry[], local: Values, remote: Values): Row[] {
	return entries.map((entry) => {
		const l = local.get(entry.vault);
		const r = remote.get(entry.vault);
		const status: RowStatus =
			l === undefined
				? r === undefined
					? "neither"
					: "remote-only"
				: r === undefined
					? "local-only"
					: l === r
						? "same"
						: "changed";
		return {
			entry,
			status,
			...(l !== undefined ? { local: l } : {}),
			...(r !== undefined ? { remote: r } : {}),
		};
	});
}

/** What a push writes to Key Vault: changed values and new ones. It never deletes. */
export function toPush(rows: readonly Row[]): Row[] {
	return rows.filter((row) => row.status === "changed" || row.status === "local-only");
}

/** What a pull writes locally: changed values and ones only Key Vault has. */
export function toPull(rows: readonly Row[]): Row[] {
	return rows.filter((row) => row.status === "changed" || row.status === "remote-only");
}

const chars = (value: string | undefined) =>
	value === undefined ? "unset" : `${value.length} character${value.length === 1 ? "" : "s"}`;

/**
 * One line per secret, never the value. `push` reads left to right as local → Key
 * Vault, `pull` as Key Vault → local.
 */
export function describe(row: Row, direction: "push" | "pull", target: Target): string {
	const name = `${row.entry.vault} (${row.entry.group === "app" ? row.entry.env : localFile(row.entry, target)})`;
	const [from, to] = direction === "push" ? [row.local, row.remote] : [row.remote, row.local];
	switch (row.status) {
		case "same":
			return `  = ${name}: the same`;
		case "neither":
			return `  - ${name}: not set either side`;
		case "changed":
			return `  ~ ${name}: changes (${chars(to)} → ${chars(from)})`;
		case "local-only":
			return direction === "push"
				? `  + ${name}: new in Key Vault (${chars(from)})`
				: `  ! ${name}: only local, not in Key Vault (left as it is)`;
		case "remote-only":
			return direction === "pull"
				? `  + ${name}: new locally (${chars(from)})`
				: `  ! ${name}: only in Key Vault (left as it is; a push never deletes)`;
	}
}

const PLAIN = /^[A-Za-z0-9_\-.:/+=@,~%]*$/;

/** A value as it goes into an env file, quoted only when it has to be. */
export function envValue(key: string, value: string): string {
	if (PLAIN.test(value)) return value;
	if (!/[\n\r]/.test(value)) {
		if (!value.includes("'")) return `'${value}'`;
		// Double quotes expand escapes like \n, so only when there's no backslash.
		if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
	}
	throw new Error(`${key} can't be written to an env file safely. Set it by hand.`);
}

const assignment = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

/**
 * Sets keys in an env file's text, keeping every other line (comments included) as it
 * is. An existing key is replaced where it is (later duplicates are dropped, since the
 * last one would win), and a new one goes at the end.
 */
export function setEnvValues(text: string, updates: ReadonlyMap<string, string>): string {
	const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	for (const [key, value] of updates) {
		const line = `${key}=${envValue(key, value)}`;
		const match = assignment(key);
		const at = lines.findIndex((l) => match.test(l));
		if (at === -1) {
			lines.push(line);
			continue;
		}
		lines[at] = line;
		for (let i = lines.length - 1; i > at; i--) {
			if (match.test(lines[i] ?? "")) lines.splice(i, 1);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** The env file to start from when a pull finds none. */
export function newEnvFile(target: Target): string {
	return [
		`# ${ENVS[target].envFile}: written by just secrets-pull ${target}. Never commit it.`,
		`PIXEL_PHONE_ENV=${target}`,
		"",
	].join("\n");
}

/** `PIXEL_PHONE_ENV` as an env file sets it. */
export function phoneEnvOf(envText: string | undefined): string | undefined {
	return envText === undefined ? undefined : parseEnv(envText).PIXEL_PHONE_ENV;
}

/**
 * Why an env file must not be pushed to a target, if it mustn't: it says it belongs to
 * another environment. Keeps dev's Telnyx key out of prod's vault and the other way round.
 */
export function wrongEnvFile(target: Target, envText: string | undefined): string | undefined {
	const declared = phoneEnvOf(envText);
	if (declared === undefined || declared === target) return undefined;
	return `${ENVS[target].envFile} says PIXEL_PHONE_ENV=${declared}, not ${target}. Refusing to push it to ${ENVS[target].vault}.`;
}

const AZ_QUIET = ["--only-show-errors"];

export function azShowArgs(target: Target, name: string): string[] {
	return [
		"keyvault",
		"secret",
		"show",
		...AZ_QUIET,
		"--vault-name",
		ENVS[target].vault,
		"--name",
		name,
		"--query",
		"value",
		"--output",
		"json",
	];
}

/** Sets a secret from a file, so the value never appears in a command line. */
export function azSetArgs(
	target: Target,
	entry: Pick<SecretEntry, "vault">,
	file: string,
): string[] {
	return [
		"keyvault",
		"secret",
		"set",
		...AZ_QUIET,
		"--vault-name",
		ENVS[target].vault,
		"--name",
		entry.vault,
		"--file",
		file,
		"--encoding",
		"utf-8",
		"--content-type",
		"text/plain",
		"--output",
		"none",
	];
}

/** Whether `az keyvault secret show` failed because the secret doesn't exist. */
export function isNotFound(stderr: string): boolean {
	return /SecretNotFound|was not found/i.test(stderr);
}

/** The value out of `az keyvault secret show --query value --output json`. */
export function parseShown(stdout: string): string {
	const value: unknown = JSON.parse(stdout);
	if (typeof value !== "string") throw new Error("az returned a secret that isn't text");
	return value;
}

/** Top-level `name =` keys in a tfvars file. */
export function tfvarsKeys(text: string): string[] {
	return [...text.matchAll(/^([a-z_][a-z0-9_]*)\s*=/gm)].map(([, key]) => key ?? "");
}

export type StackVariables = { all: ReadonlySet<string>; sensitive: ReadonlySet<string> };

/** Variables a stack's variables.tf declares, and which of them are sensitive (secret inputs). */
export function stackVariables(variablesTf: string): StackVariables {
	const all = new Set<string>();
	const sensitive = new Set<string>();
	for (const [, name, body] of variablesTf.matchAll(/^variable "([a-z0-9_]+)" \{([\s\S]*?)^\}/gm)) {
		if (!name) continue;
		all.add(name);
		if (/^\s*sensitive\s*=\s*true/m.test(body ?? "")) sensitive.add(name);
	}
	return { all, sensitive };
}

/**
 * A tfvars file as it may be shown: the value of every sensitive variable is hidden,
 * commented-out ones included, so a diff never prints a secret even when the file
 * (wrongly) holds one.
 */
export function redactTfvars(text: string, sensitive: ReadonlySet<string>): string {
	return text.replace(
		/^(\s*#?\s*)([a-z_][a-z0-9_]*)(\s*=\s*)(.*)$/gm,
		(line, lead: string, key: string, eq: string) =>
			sensitive.has(key) ? `${lead}${key}${eq}(secret, hidden)` : line,
	);
}

/**
 * What's wrong with a tfvars file before it's shared: it may only set variables this
 * env's stack declares (prod's `custom_domains` in dev's file shows it's the wrong
 * one), and never a secret, which belongs in `secrets.auto.tfvars` and never leaves the
 * laptop. Problems name keys, never values.
 */
export function tfvarsProblems(text: string, target: Target, variables: StackVariables): string[] {
	const problems: string[] = [];
	const file = tfvarsFile(target);
	for (const key of tfvarsKeys(text)) {
		if (variables.sensitive.has(key)) {
			problems.push(
				`${file} sets ${key}, which is a secret. Move it to ${secretTfvarsFile(target)}.`,
			);
		} else if (!variables.all.has(key)) {
			problems.push(`${file} sets ${key}, which infra/envs/${target} doesn't declare.`);
		}
	}
	return problems;
}

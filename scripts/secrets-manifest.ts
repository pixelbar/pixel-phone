/**
 * Loads and validates `infra/secrets.manifest.yaml`: the secrets pixel-phone keeps in
 * Azure Key Vault. Names and metadata only; values never pass through here.
 * Used by `just validate-secrets` and `just secrets-pull` / `secrets-push`.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const MANIFEST_FILE = "infra/secrets.manifest.yaml";

/** Azure Key Vault secret names: letters, digits and dashes, up to 127. Kept lowercase here. */
const vaultName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}$/, {
	error: "must be lowercase letters, digits and dashes (a Key Vault secret name)",
});
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
	error: "must be an environment variable name like TELNYX_API_KEY",
});
const featureName = z.string().regex(/^[a-z][a-z0-9-]*$/, {
	error: "must be lowercase words joined by dashes",
});
const description = z.string().trim().min(1).max(200);

const entrySchema = z.strictObject({
	vault: vaultName,
	env: envName,
	feature: featureName,
	description,
});

const manifestSchema = z.strictObject({
	version: z.literal(1),
	features: z.record(featureName, description),
	secrets: z.array(entrySchema).min(1),
});

export type SecretEntry = z.infer<typeof entrySchema>;
export type SecretsManifest = {
	features: Readonly<Record<string, string>>;
	secrets: readonly SecretEntry[];
};

export class SecretsManifestError extends Error {
	override name = "SecretsManifestError";
}

/**
 * Parses the manifest text. Every problem is collected into one error, and none of
 * them echoes a value from the file beyond the secret's own name.
 */
export function parseSecretsManifest(source: string, file = MANIFEST_FILE): SecretsManifest {
	let data: unknown;
	try {
		data = parse(source);
	} catch {
		throw new SecretsManifestError(`${file} is not valid YAML`);
	}
	const result = manifestSchema.safeParse(data);
	if (!result.success) {
		const problems = result.error.issues.map(
			(i) => `  - ${i.path.join(".") || "(file)"}: ${i.message}`,
		);
		throw new SecretsManifestError(`${file} is invalid:\n${problems.join("\n")}`);
	}

	const { features, secrets } = result.data;
	const problems: string[] = [];
	const vaults = new Set<string>();
	const envs = new Set<string>();
	const used = new Set<string>();

	for (const secret of secrets) {
		const label = `"${secret.vault}"`;
		if (vaults.has(secret.vault)) problems.push(`${label} is listed twice`);
		vaults.add(secret.vault);
		if (envs.has(secret.env)) problems.push(`${label} reuses the env ${secret.env}`);
		envs.add(secret.env);
		if (!(secret.feature in features)) {
			problems.push(`${label} uses the feature "${secret.feature}", which isn't declared`);
		}
		used.add(secret.feature);
	}
	for (const feature of Object.keys(features)) {
		if (!used.has(feature)) problems.push(`the feature "${feature}" has no secrets`);
	}

	if (problems.length > 0) {
		throw new SecretsManifestError(
			`${file} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
	}
	return { features, secrets };
}

export function loadSecretsManifest(file = MANIFEST_FILE): SecretsManifest {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new SecretsManifestError(`cannot read ${file} (${code})`);
	}
	return parseSecretsManifest(source, file);
}

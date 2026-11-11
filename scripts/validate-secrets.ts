/** `just validate-secrets`: checks infra/secrets.manifest.yaml and lists the secrets. No Azure, no values. */
import { loadSecretsManifest, SecretsManifestError } from "./secrets-manifest.ts";

try {
	const { secrets, features } = loadSecretsManifest();
	for (const s of secrets) {
		process.stdout.write(`${s.vault.padEnd(22)} ${s.env.padEnd(22)} ${s.feature}\n`);
	}
	process.stdout.write(`${secrets.length} secrets, ${Object.keys(features).length} features.\n`);
} catch (error) {
	if (error instanceof SecretsManifestError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	}
	throw error;
}

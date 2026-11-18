/**
 * `just api-key <id>`: makes a new accept API key and prints the line to add to
 * API_KEYS_YAML in `.env.<env>`. It writes nowhere: add the line, then `just secrets-push`.
 */
import { randomBytes } from "node:crypto";

export function newApiKeyLine(id: string): string {
	if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
		throw new Error("The id must be lowercase letters, digits and dashes, e.g. home-assistant.");
	}
	return `- { id: ${id}, key: ${randomBytes(32).toString("base64url")} }`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		const line = newApiKeyLine(process.argv[2] ?? "");
		process.stdout.write(
			`Add this line to API_KEYS_YAML in .env.<env> (a YAML list; keep the others), then \`just secrets-push <env>\`:\n\n${line}\n\nGive the key to the caller (Home Assistant's secrets.yaml, or Pixel's Key Vault). Don't paste it in chat.\n`,
		);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(1);
	}
}

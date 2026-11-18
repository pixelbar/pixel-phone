/**
 * `just events-schema`: writes the call event contract (src/core/events.ts) to
 * docs/events.schema.json as JSON Schema, for Pixel. `--check` fails if the file is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { phoneEvent } from "../src/core/events.ts";

export const SCHEMA_FILE = "docs/events.schema.json";

export function eventsSchema(): string {
	const schema = z.toJSONSchema(phoneEvent, { target: "draft-2020-12" });
	return `${JSON.stringify(
		{
			$id: "https://github.com/pixelbar/pixel-phone/blob/main/docs/events.schema.json",
			title: "pixel-phone call event (v1)",
			...schema,
		},
		null,
		"\t",
	)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const want = eventsSchema();
	if (process.argv.includes("--check")) {
		if (readFileSync(SCHEMA_FILE, "utf8") !== want) {
			process.stderr.write(`${SCHEMA_FILE} is stale. Run \`just events-schema\`.\n`);
			process.exit(1);
		}
	} else {
		writeFileSync(SCHEMA_FILE, want);
		process.stdout.write(`Wrote ${SCHEMA_FILE}.\n`);
	}
}

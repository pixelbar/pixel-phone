import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every .ts file under a directory, relative to the repository root. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => relative(".", join(entry.parentPath, entry.name)));
}

const IMPORT =
	/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function imports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? "");
}

/** Where a relative import lands, relative to the repository root. */
function landsIn(file: string, target: string): string {
	return relative(".", resolve(dirname(file), target));
}

describe("dependency direction (ports and adapters)", () => {
	it("src/core imports only src/core, Node built-ins and zod", () => {
		const offenders = sources("src/core").flatMap((file) =>
			imports(file)
				.filter((target) => {
					if (target.startsWith("node:") || target === "zod") return false;
					if (target.startsWith(".")) return !landsIn(file, target).startsWith("src/core/");
					return true;
				})
				.map((target) => `${file} imports ${target}`),
		);
		expect(offenders).toEqual([]);
	});

	it("nothing in src outside src/testing imports src/testing", () => {
		const offenders = sources("src")
			.filter((file) => !file.startsWith("src/testing/"))
			.flatMap((file) =>
				imports(file)
					.filter(
						(target) => target.startsWith(".") && landsIn(file, target).startsWith("src/testing/"),
					)
					.map((target) => `${file} imports ${target}`),
			);
		expect(offenders).toEqual([]);
	});
});

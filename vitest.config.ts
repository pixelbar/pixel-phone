import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// Entry points are verified by running the service, not by unit tests.
			exclude: ["src/testing/**", "src/index.ts", "src/instrument.ts"],
			reporter: ["text", "html"],
			// `just check` fails below these. The call flow answers the door for a
			// visitor, so the core gets strict floors.
			thresholds: {
				lines: 85,
				statements: 85,
				functions: 80,
				branches: 85,
				"src/core/**": { lines: 98, statements: 98, functions: 95, branches: 95 },
			},
		},
	},
});

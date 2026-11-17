/**
 * `just media push <env> <file> [--name accepted.mp3]` uploads a recording to the env's
 * private `media` container; `just media list <env>` lists them. Changing a recording
 * needs no deploy: the app signs a fresh URL for every call.
 * Needs `az login` and Storage Blob Data Contributor on media (maintainer_principal_ids).
 */
import { execFile, spawn } from "node:child_process";
import { openSync, readSync } from "node:fs";
import { promisify } from "node:util";
import { input } from "@inquirer/prompts";
import { ENVS, parseTarget } from "./envs.ts";
import { azListArgs, azUploadArgs, parseMediaArgs, planUpload } from "./media-lib.ts";

const run = promisify(execFile);

function head(file: string): Buffer {
	const buffer = Buffer.alloc(12);
	const fd = openSync(file, "r");
	readSync(fd, buffer, 0, 12, 0);
	return buffer;
}

const { command, env, file, name } = parseMediaArgs(process.argv.slice(2));
try {
	const target = parseTarget(env);
	if (command === "list") {
		await new Promise<void>((resolve, reject) =>
			spawn("az", azListArgs(target), { stdio: "inherit" }).on("exit", (code) =>
				code === 0 ? resolve() : reject(new Error("az storage blob list failed")),
			),
		);
	} else if (command === "push" && file) {
		const plan = planUpload(file, head(file), name);
		if ("problem" in plan) throw new Error(plan.problem);
		if (ENVS[target].prod) {
			const typed = await input({ message: `Replace ${plan.name} on PROD. Type "prod" to go on:` });
			if (typed.trim() !== "prod") throw new Error("Nothing uploaded.");
		}
		await run("az", azUploadArgs(target, file, plan.name, plan.format));
		process.stdout.write(
			`Uploaded ${file} as ${plan.name} to ${ENVS[target].storageAccount}/media. The next accepted call plays it.\n`,
		);
	} else {
		throw new Error(
			"Usage: just media push <env> <file> [--name accepted.mp3] | just media list <env>",
		);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

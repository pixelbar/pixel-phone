/**
 * `just telnyx-sync <env> [--dry-run | --check] [--yes] [--from-vault]` (ADR 0007): makes
 * the environment's Call Control application and numbers match `config/telnyx.<env>.yaml`.
 *
 * - The webhook host is `host` from that file, or else the Container App's hostname
 *   (`az containerapp show`).
 * - TELNYX_API_KEY comes from `.env.<env>`, or from Key Vault with `--from-vault`. It is
 *   never printed.
 * - It prints what would change and asks first. `--yes` skips the question (prod still
 *   asks unless `--yes` is given with PIXEL_PHONE_SYNC_PROD=1).
 * - `--dry-run` only prints. `--check` prints and exits 1 when anything differs (drift).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import { ENVS, parseTarget, type Target } from "./envs.ts";
import { azShowArgs, parseShown } from "./secrets-sync-lib.ts";
import {
	applyPlan,
	formatPlan,
	hasChanges,
	loadTelnyxEnvFile,
	makePlan,
	planProblems,
	TELNYX_API,
	TelnyxAdminApi,
} from "./telnyx-sync-lib.ts";

const run = promisify(execFile);

async function apiKey(target: Target, fromVault: boolean): Promise<string> {
	if (fromVault) {
		try {
			const { stdout } = await run("az", azShowArgs(target, "telnyx-api-key"));
			return parseShown(stdout);
		} catch {
			throw new Error(
				`Couldn't read telnyx-api-key from ${ENVS[target].vault}. Are you signed in (az login)?`,
			);
		}
	}
	const file = ENVS[target].envFile;
	const key = existsSync(file) ? parseEnv(readFileSync(file, "utf8")).TELNYX_API_KEY : undefined;
	if (!key) {
		throw new Error(
			`TELNYX_API_KEY isn't set in ${file}. Add it, run \`just secrets-pull ${target}\`, or pass --from-vault.`,
		);
	}
	return key;
}

async function containerAppHost(target: Target): Promise<string> {
	const env = ENVS[target];
	try {
		const { stdout } = await run("az", [
			"containerapp",
			"show",
			"--only-show-errors",
			"-g",
			env.resourceGroup,
			"-n",
			env.app,
			"--query",
			"properties.configuration.ingress.fqdn",
			"-o",
			"tsv",
		]);
		const host = stdout.trim();
		if (host === "") throw new Error("no ingress hostname");
		return host;
	} catch {
		throw new Error(
			`Couldn't read ${env.app}'s hostname with az. Sign in (az login), or set host in config/telnyx.${target}.yaml.`,
		);
	}
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const known = new Set(["--dry-run", "--check", "--yes", "--from-vault"]);
try {
	for (const flag of flags) if (!known.has(flag)) throw new Error(`Unknown option ${flag}.`);
	const target = parseTarget(args.find((a) => !a.startsWith("--")));
	const file = loadTelnyxEnvFile(target);
	const host = file.host ?? (await containerAppHost(target));
	const api = new TelnyxAdminApi(
		await apiKey(target, flags.has("--from-vault")),
		process.env.TELNYX_API_URL ?? TELNYX_API,
	);

	const plan = await makePlan(api, target, file, host);
	process.stdout.write(`Telnyx for ${target} (webhooks to ${host}):\n${formatPlan(plan)}\n`);
	const problems = planProblems(plan);
	if (problems.length > 0) throw new Error(problems.join("\n"));

	if (!hasChanges(plan)) {
		process.stdout.write("Nothing to change.\n");
	} else if (flags.has("--check")) {
		process.stderr.write(
			`Telnyx has drifted from config/telnyx.${target}.yaml. Run \`just telnyx-sync ${target}\` to put it back.\n`,
		);
		process.exitCode = 1;
	} else if (flags.has("--dry-run")) {
		process.stdout.write("Dry run: nothing written.\n");
	} else {
		let go: boolean;
		if (ENVS[target].prod) {
			go =
				(flags.has("--yes") && process.env.PIXEL_PHONE_SYNC_PROD === "1") ||
				(
					await input({ message: 'This changes the PROD doorbell. Type "prod" to go on:' })
				).trim() === "prod";
		} else {
			go =
				flags.has("--yes") || (await confirm({ message: `Apply to ${target}?`, default: false }));
		}
		if (!go) {
			process.stdout.write("Nothing written.\n");
		} else {
			const id = await applyPlan(api, plan);
			process.stdout.write(`Done. ${plan.desired.application_name} is ${id}.\n`);
		}
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

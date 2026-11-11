/**
 * `just secrets-pull <env>` and `just secrets-push <env>`: sync the app secrets listed in
 * infra/secrets.manifest.yaml between the laptop env file (`.env.dev` / `.env.prod`) and
 * that environment's Key Vault. The only writer of these secrets (Pixel ADR 0017).
 *
 * It shows what would change, never a value, and asks before writing (`--yes` skips the
 * question on dev only). A push never
 * deletes, and refuses an env file that says it belongs to the other environment.
 * Needs `az login` and Key Vault Administrator on the vault (the applier gets it).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import { ENVS, parseTarget, type Target } from "./envs.ts";
import { loadSecretsManifest, type SecretEntry } from "./secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	isNotFound,
	localValues,
	newEnvFile,
	parseShown,
	setEnvValues,
	toPull,
	toPush,
	wrongEnvFile,
} from "./secrets-sync-lib.ts";

const run = promisify(execFile);

async function remoteValues(target: Target, entries: readonly SecretEntry[]) {
	const out = new Map<string, string>();
	await Promise.all(
		entries.map(async (entry) => {
			try {
				const { stdout } = await run("az", azShowArgs(target, entry.vault));
				out.set(entry.vault, parseShown(stdout));
			} catch (error) {
				const stderr = (error as { stderr?: string }).stderr ?? "";
				if (isNotFound(stderr)) return;
				throw new Error(
					`Couldn't read ${entry.vault} from ${ENVS[target].vault}. Are you signed in (az login) with access to the vault?`,
				);
			}
		}),
	);
	return out;
}

function readEnvFile(target: Target): string | undefined {
	const file = ENVS[target].envFile;
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** `--yes` skips the question, for dev only: prod always asks. */
let assumeYes = false;

async function confirmTarget(target: Target, action: string): Promise<boolean> {
	if (!ENVS[target].prod) {
		return assumeYes || confirm({ message: `${action} ${target}?`, default: false });
	}
	const typed = await input({ message: `${action} PROD. Type "prod" to go on:` });
	return typed.trim() === "prod";
}

async function push(target: Target) {
	const { secrets } = loadSecretsManifest();
	const envText = readEnvFile(target);
	if (envText === undefined) throw new Error(`${ENVS[target].envFile} doesn't exist.`);
	const wrong = wrongEnvFile(target, envText);
	if (wrong) throw new Error(wrong);

	const rows = compare(secrets, localValues(secrets, envText), await remoteValues(target, secrets));
	for (const row of rows) process.stdout.write(`${describe(row, "push")}\n`);
	const changes = toPush(rows);
	if (changes.length === 0) {
		process.stdout.write("Nothing to push.\n");
		return;
	}
	if (
		!(await confirmTarget(target, `Write ${changes.length} secret(s) to ${ENVS[target].vault} for`))
	) {
		process.stdout.write("Nothing written.\n");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "pixel-phone-secrets-"));
	try {
		for (const row of changes) {
			const file = join(dir, row.entry.vault);
			writeFileSync(file, row.local ?? "", { mode: 0o600 });
			await run("az", azSetArgs(target, row.entry, file));
			rmSync(file);
			process.stdout.write(`  wrote ${row.entry.vault}\n`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	process.stdout.write(
		`Done. The Container App reads secrets when a revision starts: run \`just restart ${target}\` to pick them up now.\n`,
	);
}

async function pull(target: Target) {
	const { secrets } = loadSecretsManifest();
	const envText = readEnvFile(target);
	const rows = compare(secrets, localValues(secrets, envText), await remoteValues(target, secrets));
	for (const row of rows) process.stdout.write(`${describe(row, "pull")}\n`);
	const changes = toPull(rows);
	if (changes.length === 0) {
		process.stdout.write("Nothing to pull.\n");
		return;
	}
	if (
		!(await confirm({
			message: `Write ${changes.length} value(s) to ${ENVS[target].envFile}?`,
			default: false,
		}))
	) {
		process.stdout.write("Nothing written.\n");
		return;
	}
	const updates = new Map(changes.map((row) => [row.entry.env, row.remote ?? ""]));
	writeFileSync(ENVS[target].envFile, setEnvValues(envText ?? newEnvFile(target), updates), {
		mode: 0o600,
	});
	process.stdout.write(`Wrote ${ENVS[target].envFile}.\n`);
}

const args = process.argv.slice(2);
assumeYes = args.includes("--yes");
const [command, env] = args.filter((arg) => arg !== "--yes");
try {
	const target = parseTarget(env);
	if (assumeYes && ENVS[target].prod) throw new Error("--yes is for dev only. Prod always asks.");
	if (command === "push") await push(target);
	else if (command === "pull") await pull(target);
	else throw new Error("Usage: secrets-sync.ts push|pull dev|prod");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

/**
 * Syncs an environment's secrets and settings between Key Vault and this laptop.
 * Usage: `just pull dev|prod` / `just push dev|prod` (everything below), or
 *        `just secrets-pull dev|prod` / `just secrets-push dev|prod` (app secrets only).
 *
 * What, from infra/secrets.manifest.yaml:
 *   - `app` secrets: in `.env.dev` / `.env.prod` under their environment variable.
 *   - `tooling` (`just pull` / `push` only): the stack's settings, `terraform-tfvars`, in
 *     `infra/envs/<env>/terraform.tfvars` (ADR 0012). A secret Terraform input never goes
 *     in it: it belongs in `secrets.auto.tfvars`, which stays on the laptop.
 *
 * pull: reads Key Vault, shows what would change (a diff for the tfvars), and asks before
 *       writing anything locally.
 * push: reads Key Vault (the live values), shows what would change and asks (`--yes`
 *       skips the question on dev only). It refuses an env file that says it's for the
 *       other environment, and a tfvars that sets a secret or a variable the stack doesn't
 *       declare. Before writing it checks the vault hasn't changed since it was read, and
 *       after writing it reads every value back. A push never deletes.
 *
 * Secret values are never printed: a secret is shown by name and length. The tfvars holds
 * no secret (push refuses one that does), so its diff is shown, with any sensitive
 * variable hidden all the same. Needs `az login` and Key Vault Administrator on the
 * vault, which everyone in the environment's `maintainer_principal_ids` gets (docs/infra.md).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import { ENVS, parseTarget, type Target } from "./envs.ts";
import { loadSecretsManifest, type SecretEntry, SecretsManifestError } from "./secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	isFile,
	isNotFound,
	localFile,
	localValues,
	newEnvFile,
	parseShown,
	type Row,
	redactTfvars,
	setEnvValues,
	stackVariables,
	syncedSecrets,
	TFVARS_SECRET,
	tfvarsFile,
	tfvarsProblems,
	toPull,
	toPush,
	wrongEnvFile,
} from "./secrets-sync-lib.ts";

const run = promisify(execFile);

type Scope = "secrets" | "all";

/** Stops with a message for the person running it, not a stack trace. */
class Stop extends Error {}

const say = (line = "") => process.stdout.write(`${line}\n`);

const work = mkdtempSync(join(tmpdir(), "pixel-phone-secrets-"));

function readText(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function writePrivate(file: string, text: string): void {
	writeFileSync(file, text, { mode: 0o600 });
}

async function readVault(target: Target, entries: readonly SecretEntry[]) {
	const out = new Map<string, string>();
	await Promise.all(
		entries.map(async (entry) => {
			try {
				const { stdout } = await run("az", azShowArgs(target, entry.vault));
				out.set(entry.vault, parseShown(stdout));
			} catch (error) {
				const stderr = (error as { stderr?: string }).stderr ?? "";
				if (isNotFound(stderr)) return;
				throw new Stop(
					`Couldn't read ${entry.vault} from ${ENVS[target].vault}. Are you signed in (az login) with access to the vault?`,
				);
			}
		}),
	);
	return out;
}

function localFiles(entries: readonly SecretEntry[], target: Target) {
	return new Map(
		entries.filter(isFile).map((entry) => [entry.vault, readText(localFile(entry, target))]),
	);
}

function variablesOf(target: Target) {
	return stackVariables(readFileSync(join("infra", "envs", target, "variables.tf"), "utf8"));
}

/** A file secret's text as it may be shown in a diff: never a sensitive tfvars value. */
function shown(entry: SecretEntry, target: Target, text: string | undefined) {
	if (text === undefined || entry.vault !== TFVARS_SECRET) return text;
	return redactTfvars(text, variablesOf(target).sensitive);
}

async function showDiff(from: string | undefined, to: string, labels: [string, string]) {
	const a = join(work, "from");
	const b = join(work, "to");
	writePrivate(a, from ?? "");
	writePrivate(b, to);
	try {
		await run("diff", ["-u", "--label", labels[0], "--label", labels[1], a, b]);
	} catch (error) {
		// diff exits 1 when the files differ, which is the point.
		say((error as { stdout?: string }).stdout ?? "");
	} finally {
		rmSync(a, { force: true });
		rmSync(b, { force: true });
	}
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

function summary(rows: readonly Row[], direction: "push" | "pull", target: Target) {
	for (const row of rows) say(describe(row, direction, target));
	say();
}

/** The first time an env shares its tfvars, Key Vault has none to pull. */
function firstTfvarsHint(rows: readonly Row[], target: Target): void {
	const row = rows.find((r) => r.entry.vault === TFVARS_SECRET);
	if (row === undefined || row.remote !== undefined) return;
	const file = tfvarsFile(target);
	say(
		row.local === undefined
			? `${ENVS[target].vault} has no ${TFVARS_SECRET} yet. Start one from the example: cp infra/envs/${target}/terraform.example.tfvars ${file}, check it, then just push ${target}.`
			: `${ENVS[target].vault} has no ${TFVARS_SECRET} yet. Share your ${file} with just push ${target}.`,
	);
}

async function pull(target: Target, entries: readonly SecretEntry[], scope: Scope) {
	const { envFile, vault } = ENVS[target];
	const envText = readText(envFile);
	say(`Reading ${entries.length} secrets from ${vault} (${target})…`);
	const rows = compare(
		entries,
		localValues(entries, envText, localFiles(entries, target)),
		await readVault(target, entries),
	);
	summary(rows, "pull", target);

	const changes = toPull(rows);
	if (changes.length === 0) {
		say("Nothing to pull: local already matches.");
	} else {
		for (const row of changes) {
			if (!isFile(row.entry) || row.remote === undefined) continue;
			await showDiff(
				shown(row.entry, target, row.local),
				shown(row.entry, target, row.remote) ?? "",
				[localFile(row.entry, target), `${vault}/${row.entry.vault}`],
			);
		}
		const overwrites = changes.filter((row) => row.status === "changed").length;
		const ok = await confirm({
			message:
				overwrites > 0
					? `Write ${changes.length} value(s) locally? ${overwrites} overwrite a local value you haven't pushed.`
					: `Write ${changes.length} value(s) locally?`,
			default: false,
		});
		if (!ok) throw new Stop("Nothing written.");

		const env = new Map<string, string>();
		const written = new Set<string>();
		for (const row of changes) {
			if (row.remote === undefined) continue;
			if (row.entry.group === "app") {
				env.set(row.entry.env, row.remote);
			} else {
				writePrivate(localFile(row.entry, target), row.remote);
				written.add(localFile(row.entry, target));
			}
		}
		if (env.size > 0) {
			writePrivate(envFile, setEnvValues(envText ?? newEnvFile(target), env));
			written.add(envFile);
		}
		say(`Wrote ${[...written].join(", ")}.`);
	}

	if (scope === "all") {
		firstTfvarsHint(rows, target);
		say(`Edit what you need, then: just push ${target}. For Terraform: just tf-plan ${target}`);
	}
}

async function push(target: Target, entries: readonly SecretEntry[], scope: Scope) {
	const { envFile, vault, app } = ENVS[target];
	const envText = readText(envFile);
	if (envText === undefined) {
		throw new Stop(
			`${envFile} doesn't exist. Run just ${scope === "all" ? "pull" : "secrets-pull"} ${target} first.`,
		);
	}
	const wrong = wrongEnvFile(target, envText);
	if (wrong) throw new Stop(wrong);

	const local = localValues(entries, envText, localFiles(entries, target));
	say(`Reading ${entries.length} secrets from ${vault} (${target})…`);
	const live = await readVault(target, entries);
	const rows = compare(entries, local, live);
	summary(rows, "push", target);

	const changes = toPush(rows);
	if (changes.length === 0) {
		say(`Nothing to push: ${vault} already matches.`);
		if (scope === "all") firstTfvarsHint(rows, target);
		return;
	}
	for (const row of changes) {
		if (!isFile(row.entry) || row.local === undefined) continue;
		// Checked before anything is shown: a tfvars that holds a secret stops here.
		if (row.entry.vault === TFVARS_SECRET) {
			const problems = tfvarsProblems(row.local, target, variablesOf(target));
			if (problems.length > 0) throw new Stop(`${problems.join("\n")}\nNothing was pushed.`);
		}
		await showDiff(
			shown(row.entry, target, row.remote),
			shown(row.entry, target, row.local) ?? "",
			[`${vault}/${row.entry.vault}`, localFile(row.entry, target)],
		);
	}
	if (!(await confirmTarget(target, `Write ${changes.length} secret(s) to ${vault} for`))) {
		throw new Stop("Nothing was pushed.");
	}

	// Someone else may have pushed while you were reading the diff.
	const changing = changes.map((row) => row.entry);
	const again = await readVault(target, changing);
	for (const entry of changing) {
		if (again.get(entry.vault) !== live.get(entry.vault)) {
			throw new Stop(
				`${entry.vault} changed in ${vault} since it was read. Run just ${scope === "all" ? "pull" : "secrets-pull"} ${target}, redo your edit and push again. Nothing was pushed.`,
			);
		}
	}

	const done: string[] = [];
	for (const row of changes) {
		const file = join(work, "value");
		writePrivate(file, row.local ?? "");
		try {
			await run("az", azSetArgs(target, row.entry, file));
		} catch {
			const pushed =
				done.length > 0 ? ` Already pushed: ${done.join(", ")}.` : " Nothing was pushed.";
			throw new Stop(`Couldn't set ${row.entry.vault} in ${vault}.${pushed}`);
		} finally {
			rmSync(file, { force: true });
		}
		done.push(row.entry.vault);
		say(`  wrote ${row.entry.vault}`);
	}
	const back = await readVault(target, changing);
	const differ = changing.filter((entry) => back.get(entry.vault) !== local.get(entry.vault));
	if (differ.length > 0) {
		throw new Stop(
			`Pushed, but ${differ.map((e) => e.vault).join(", ")} don't read back the same. Check by hand.`,
		);
	}

	if (changing.some((e) => e.group === "tooling")) {
		say(
			`The shared tfvars changed. Nothing is applied yet: run just tf-plan ${target}, then apply.`,
		);
	}
	if (changing.some((e) => e.group === "app")) {
		say(
			`${app} reads secrets when a revision starts: run \`just restart ${target}\` to pick them up now.`,
		);
	}
}

function parseArgs(argv: readonly string[]) {
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
	const [command, env, ...rest] = argv.filter((arg) => !arg.startsWith("--"));
	const unknown = [...flags].filter((flag) => flag !== "--yes" && flag !== "--all");
	if ((command !== "push" && command !== "pull") || rest.length > 0 || unknown.length > 0) {
		throw new Stop("Usage: secrets-sync.ts push|pull dev|prod [--all] [--yes]");
	}
	const target = parseTarget(env);
	const scope: Scope = flags.has("--all") ? "all" : "secrets";
	assumeYes = flags.has("--yes");
	if (assumeYes && ENVS[target].prod) throw new Stop("--yes is for dev only. Prod always asks.");
	return { command, target, scope };
}

try {
	const { command, target, scope } = parseArgs(process.argv.slice(2));
	const entries = syncedSecrets(loadSecretsManifest(), scope);
	if (command === "push") await push(target, entries, scope);
	else await pull(target, entries, scope);
} catch (error) {
	if (error instanceof Error && error.name === "ExitPromptError") {
		process.stderr.write("Cancelled. Nothing more was written.\n");
		process.exitCode = 130;
	} else if (error instanceof Stop || error instanceof SecretsManifestError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} else {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

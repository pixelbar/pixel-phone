/**
 * `just simulate-call [options]`: runs a whole doorbell call on a laptop, with no Telnyx,
 * Home Assistant or Azure. It starts the real app (src/index.ts) against Azurite and two
 * fakes on local ports, plays the Telnyx side with signed webhooks, accepts through the
 * real accept API, and prints a timeline of webhooks, commands, ringer changes, queue
 * messages and the app's own call log lines.
 *
 * Needs Azurite (`just azurite`). `--help` lists the options.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import { startFakeHomeAssistant } from "../src/testing/fake-home-assistant.ts";
import { startFakeTelnyxServer } from "../src/testing/fake-telnyx-server.ts";
import { parseOptions, predictedOutcome, stamp } from "./simulate-call-lib.ts";

const AZURITE = "UseDevelopmentStorage=true";
const ENTITY = "input_boolean.pixel_phone_ringing_dev";
const KEYS = {
	"home-assistant": `harness-ha-${randomBytes(16).toString("hex")}`,
	pixel: `harness-pixel-${randomBytes(16).toString("hex")}`,
};
const QUIET = new Set(["http.request", "telnyx.webhook", "telnyx.webhook_duplicate"]);

const started = Date.now();
const lines: { at: number; text: string }[] = [];
function note(text: string) {
	const at = Date.now() - started;
	lines.push({ at, text });
	process.stdout.write(`${stamp(at)}  ${text}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function azuriteReady(): Promise<boolean> {
	try {
		await BlobServiceClient.fromConnectionString(AZURITE).getProperties({
			abortSignal: AbortSignal.timeout(1500),
		});
		return true;
	} catch {
		return false;
	}
}

let options: ReturnType<typeof parseOptions>;
try {
	options = parseOptions(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${(error as Error).message}\n`);
	process.exit(2);
}

if (!(await azuriteReady())) {
	process.stderr.write("Azurite isn't running. Start it with `just azurite`.\n");
	process.exit(2);
}

// --- The world around the app ----------------------------------------------------------

const appUrl = `http://127.0.0.1:${options.port}`;
const telnyx = await startFakeTelnyxServer({ webhookUrl: `${appUrl}/webhooks/telnyx` });
telnyx.onActivity = note;
const ha = await startFakeHomeAssistant();
ha.onCall = (service, entity) => note(`home assistant ← ${service} ${entity}`);
if (options.haDown) ha.mode = 503;

const queueName = options.queueDown ? "QUEUE_DOWN" : `harness-${randomBytes(4).toString("hex")}`;
const queue = new QueueClient(AZURITE, options.queueDown ? "harness-unused" : queueName);
if (!options.queueDown) await queue.createIfNotExists();

// The test recording, as the app would find it in Azure.
const media = BlobServiceClient.fromConnectionString(AZURITE).getContainerClient("media");
await media.createIfNotExists();
const wav = readFileSync("media/placeholder-accepted.wav");
await media.uploadBlockBlob("accepted.wav", wav, wav.length);

// --- The app -----------------------------------------------------------------------------

const app: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
	env: {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		PIXEL_PHONE_ENV: "local",
		PORT: String(options.port),
		LOG_LEVEL: "info",
		TELNYX_API_KEY: telnyx.api.apiKey,
		TELNYX_PUBLIC_KEY: telnyx.signer.publicKeyBase64,
		TELNYX_API_URL: telnyx.api.url,
		HOME_ASSISTANT_URL: ha.url,
		HOME_ASSISTANT_TOKEN: ha.token,
		HOME_ASSISTANT_RINGING_ENTITY: ENTITY,
		API_KEYS_YAML: `[{ id: home-assistant, key: ${KEYS["home-assistant"]} }, { id: pixel, key: ${KEYS.pixel} }]`,
		AZURE_STORAGE_CONNECTION_STRING: AZURITE,
		PHONE_EVENTS_QUEUE: queueName,
		ACCEPT_WINDOW_SECONDS: String(options.window),
		RECORDING_ACCEPTED: "accepted.wav",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

let firstCallId: string | undefined;
let outcome: { type: string; reason?: string } | undefined;
const appOutput: string[] = [];

function onAppLine(line: string) {
	appOutput.push(line);
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	const event = String(entry.event ?? "");
	if (!event || QUIET.has(event)) return;
	if (!/^(call|accept|process\.started)|\.failed$/.test(event)) return;
	if (event === "call.ringing" && firstCallId === undefined) firstCallId = String(entry.callId);
	const bits = ["callId", "reason", "via", "by", "activeCallId", "during", "type"]
		.filter((k) => entry[k] !== undefined)
		.map((k) => `${k}=${String(entry[k])}`);
	const err = (entry.err as { message?: string } | undefined)?.message;
	note(`app: ${event}${bits.length ? ` ${bits.join(" ")}` : ""}${err ? ` (${err})` : ""}`);
	if ((event === "call.ended" || event === "call.missed") && entry.callId === firstCallId) {
		outcome = { type: event.slice(5), ...(entry.reason ? { reason: String(entry.reason) } : {}) };
	}
}
if (app.stdout) createInterface({ input: app.stdout }).on("line", onAppLine);
if (app.stderr) createInterface({ input: app.stderr }).on("line", (l) => appOutput.push(l));

let stopping = false;
async function stop(code: number) {
	if (stopping) return;
	stopping = true;
	app.kill("SIGTERM");
	await telnyx.close();
	await ha.close();
	if (!options.queueDown) await queue.delete().catch(() => {});
	process.exit(code);
}
process.once("SIGINT", () => void stop(130));
app.once("exit", (code) => {
	if (!stopping) {
		process.stderr.write(
			`The app exited (${code}). Its output:\n${appOutput.slice(-30).join("\n")}\n`,
		);
		void stop(1);
	}
});

for (let i = 0; ; i++) {
	try {
		if ((await fetch(`${appUrl}/healthz`)).ok) break;
	} catch {
		// not up yet
	}
	if (i > 100) {
		process.stderr.write(
			`The app didn't start on ${appUrl}.\n${appOutput.slice(-30).join("\n")}\n`,
		);
		await stop(1);
	}
	await sleep(100);
}

// --- Queue messages, as Pixel would see them ---------------------------------------------

const polling = (async () => {
	while (!stopping && !options.queueDown) {
		try {
			const { receivedMessageItems } = await queue.receiveMessages({ numberOfMessages: 32 });
			for (const m of receivedMessageItems) {
				const e = JSON.parse(m.messageText) as Record<string, unknown>;
				const extra = ["reason", "via", "by", "activeCallId"]
					.filter((k) => e[k] !== undefined)
					.map((k) => `${k}=${String(e[k])}`);
				note(`queue → pixel: ${String(e.type)}${extra.length ? ` ${extra.join(" ")}` : ""}`);
				await queue.deleteMessage(m.messageId, m.popReceipt);
			}
		} catch {
			// The queue is shared with the app; try again.
		}
		await sleep(200);
	}
})();

// --- The scenario --------------------------------------------------------------------------

const door = `v3:harness-${randomBytes(4).toString("hex")}`;
const caller = { direction: "incoming", from: "+31201234567", to: "+31103024128" };
process.stdout.write(
	`\nSimulating a doorbell call (${options.window} s window). Expect: ${options.expect ?? predictedOutcome(options)}.\n\n`,
);
const t0 = Date.now();
const at = (s: number) => sleep(Math.max(0, t0 + s * 1000 - Date.now()));
await telnyx.send("call.initiated", door, caller);

const steps: Promise<void>[] = [];
if (options.secondCall) {
	steps.push(
		(async () => {
			await at(1);
			await telnyx.send("call.initiated", `${door}-2`, { ...caller, from: "+31209876543" });
		})(),
	);
}
if (options.hangupAfter !== undefined) {
	const s = options.hangupAfter;
	steps.push(
		(async () => {
			await at(s);
			if (!outcome) await telnyx.send("call.hangup", door, { hangup_cause: "normal_clearing" });
		})(),
	);
}
if (options.acceptAfter !== undefined) {
	const s = options.acceptAfter;
	steps.push(
		(async () => {
			await at(s);
			const via = options.acceptVia;
			const path =
				via === "pixel"
					? `/api/v1/calls/${firstCallId ?? "unknown"}/accept`
					: "/api/v1/calls/current/accept";
			const res = await fetch(`${appUrl}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${KEYS[via]}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(via === "pixel" ? { by: "discord:harness" } : {}),
			});
			note(`${via} → POST ${path} → ${res.status} ${await res.text()}`);
		})(),
	);
}

const deadline = t0 + (options.window + 15) * 1000;
while (!outcome && Date.now() < deadline) await sleep(100);
await Promise.allSettled(steps);
await sleep(1500); // trailing events: the last queue message, our own hang-up's webhook
stopping = true;
await polling;

if (process.env.HARNESS_DEBUG)
	process.stdout.write(`\n--- app output ---\n${appOutput.join("\n")}\n`);
const expected = options.expect;
const got = outcome
	? `${outcome.type}${outcome.reason ? ` (${outcome.reason})` : ""}`
	: "no outcome";
process.stdout.write(
	`\nOutcome: ${got}. Telnyx commands: ${telnyx.api.requests.map((r) => r.path.split("/").pop()).join(", ") || "none"}.\n`,
);
if (expected && outcome?.type !== expected) {
	process.stderr.write(`Expected ${expected}, got ${got}.\n`);
	stopping = false;
	await stop(1);
}
stopping = false;
await stop(outcome ? 0 : 1);

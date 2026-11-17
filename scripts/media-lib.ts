/** The pure parts of `just media`: recognising audio files and building az arguments. */
import { basename } from "node:path";
import { ENVS, type Target } from "./envs.ts";

export const MEDIA_CONTAINER = "media";

export type AudioFormat = "mp3" | "wav";

/** What the file's first bytes say it is. Telnyx plays MP3 and WAV. */
export function audioFormat(head: Buffer): AudioFormat | undefined {
	if (head.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
	if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
	if (
		head.subarray(0, 4).toString("latin1") === "RIFF" &&
		head.subarray(8, 12).toString("latin1") === "WAVE"
	) {
		return "wav";
	}
	return undefined;
}

export const CONTENT_TYPES: Record<AudioFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav" };

/** Checks the upload and picks its blob name. Returns a problem, or the plan. */
export function planUpload(
	file: string,
	head: Buffer,
	name: string | undefined,
): { name: string; format: AudioFormat } | { problem: string } {
	const format = audioFormat(head);
	if (!format) return { problem: `${file} isn't an MP3 or WAV file.` };
	const blob = name ?? basename(file);
	if (!/^[\w.-]+$/.test(blob)) return { problem: `${blob} isn't a plain blob name.` };
	if (!blob.toLowerCase().endsWith(`.${format}`)) {
		return {
			problem: `${file} is ${format.toUpperCase()}, so its name must end in .${format} (got ${blob}).`,
		};
	}
	return { name: blob, format };
}

const base = (target: Target) => [
	"--only-show-errors",
	"--auth-mode",
	"login",
	"--account-name",
	ENVS[target].storageAccount,
	"--container-name",
	MEDIA_CONTAINER,
];

export function azUploadArgs(target: Target, file: string, name: string, format: AudioFormat) {
	return [
		"storage",
		"blob",
		"upload",
		...base(target),
		"--file",
		file,
		"--name",
		name,
		"--content-type",
		CONTENT_TYPES[format],
		"--overwrite",
		"-o",
		"none",
	];
}

export function azListArgs(target: Target) {
	return [
		"storage",
		"blob",
		"list",
		...base(target),
		"--query",
		"[].{name:name, bytes:properties.contentLength, type:properties.contentSettings.contentType, modified:properties.lastModified}",
		"-o",
		"table",
	];
}

/** `push <env> <file> [--name x]` or `list <env>`; `--name` may come anywhere. */
export function parseMediaArgs(argv: readonly string[]): {
	command?: string;
	env?: string;
	file?: string;
	name?: string;
} {
	const nameAt = argv.indexOf("--name");
	const name = nameAt >= 0 ? argv[nameAt + 1] : undefined;
	const [command, env, file] =
		nameAt < 0 ? argv : argv.filter((_, i) => i !== nameAt && i !== nameAt + 1);
	return {
		...(command ? { command } : {}),
		...(env ? { env } : {}),
		...(file ? { file } : {}),
		...(name ? { name } : {}),
	};
}

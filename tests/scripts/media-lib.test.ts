import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	audioFormat,
	azListArgs,
	azUploadArgs,
	parseMediaArgs,
	planUpload,
} from "../../scripts/media-lib.ts";

const wav = readFileSync("media/placeholder-accepted.wav").subarray(0, 12);
const id3 = Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000", "latin1");
const frame = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("just media", () => {
	it("recognises MP3 and WAV by their first bytes", () => {
		expect(audioFormat(wav)).toBe("wav");
		expect(audioFormat(id3)).toBe("mp3");
		expect(audioFormat(frame)).toBe("mp3");
		expect(audioFormat(Buffer.from("hello world!"))).toBeUndefined();
		expect(audioFormat(Buffer.alloc(0))).toBeUndefined();
	});

	it("names the blob after the file unless told, and checks the extension", () => {
		expect(planUpload("media/placeholder-accepted.wav", wav, "accepted.wav")).toEqual({
			name: "accepted.wav",
			format: "wav",
		});
		expect(planUpload("x/accepted.mp3", id3, undefined)).toEqual({
			name: "accepted.mp3",
			format: "mp3",
		});
		expect(planUpload("a.wav", wav, "accepted.mp3")).toMatchObject({ problem: /must end in .wav/ });
		expect(planUpload("a.txt", Buffer.from("text"), undefined)).toMatchObject({
			problem: /isn't an MP3 or WAV/,
		});
		expect(planUpload("a.wav", wav, "../evil.wav")).toMatchObject({ problem: /plain blob name/ });
	});

	it("reads its arguments with or without --name", () => {
		expect(parseMediaArgs(["list", "dev"])).toEqual({ command: "list", env: "dev" });
		expect(parseMediaArgs(["push", "dev", "a.wav"])).toEqual({
			command: "push",
			env: "dev",
			file: "a.wav",
		});
		expect(parseMediaArgs(["push", "dev", "a.wav", "--name", "accepted.wav"])).toEqual({
			command: "push",
			env: "dev",
			file: "a.wav",
			name: "accepted.wav",
		});
		expect(parseMediaArgs(["push", "--name", "x.wav", "dev", "a.wav"])).toMatchObject({
			env: "dev",
			file: "a.wav",
		});
	});

	it("uploads with az login auth to the env's media container, never with keys", () => {
		const args = azUploadArgs("dev", "a.wav", "accepted.wav", "wav");
		expect(args).toEqual(
			expect.arrayContaining([
				"--auth-mode",
				"login",
				"pixelphonedevst",
				"media",
				"audio/wav",
				"--overwrite",
			]),
		);
		expect(args.join(" ")).not.toMatch(/account-key|sas-token|connection-string/);
		expect(azListArgs("prod")).toContain("pixelphoneprodst");
	});
});

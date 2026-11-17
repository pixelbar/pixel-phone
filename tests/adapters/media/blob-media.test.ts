import { readFileSync } from "node:fs";
import type { UserDelegationKey } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	BlobMedia,
	blobServiceClient,
	NoMedia,
	SAS_LIFETIME_MS,
} from "../../../src/adapters/media/blob-media.ts";
import { AZURITE, azuriteUp, uniqueName } from "../../helpers/azurite.ts";

describe.skipIf(!azuriteUp)("BlobMedia (Azurite)", () => {
	const service = blobServiceClient({ kind: "connection-string", connectionString: AZURITE });
	const container = uniqueName("media");
	beforeAll(async () => {
		await service.createContainer(container);
		const wav = readFileSync("media/placeholder-accepted.wav");
		await service.getContainerClient(container).uploadBlockBlob("accepted.wav", wav, wav.length);
	});
	afterAll(() => service.deleteContainer(container));

	it("signs a read-only URL that works, and says what exists", async () => {
		const media = new BlobMedia(service, container, "connection-string");
		expect(await media.exists("accepted.wav")).toBe(true);
		expect(await media.exists("missing.mp3")).toBe(false);
		const url = await media.urlFor("accepted.wav");
		const sas = new URL(url).searchParams;
		expect(sas.get("sp")).toBe("r");
		const lifetime = new Date(sas.get("se") ?? "").getTime() - Date.now();
		expect(lifetime).toBeGreaterThan(SAS_LIFETIME_MS - 60_000);
		expect(lifetime).toBeLessThanOrEqual(SAS_LIFETIME_MS);
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect((await res.arrayBuffer()).byteLength).toBe(
			readFileSync("media/placeholder-accepted.wav").length,
		);
		// The container itself stays private.
		expect((await fetch(url.split("?")[0] ?? "")).status).not.toBe(200);
	});

	it("refuses an expired URL", async () => {
		const past = new BlobMedia(
			service,
			container,
			"connection-string",
			() => new Date(Date.now() - SAS_LIFETIME_MS - 120_000),
		);
		const res = await fetch(await past.urlFor("accepted.wav"));
		expect(res.status).toBe(403);
	});
});

describe("BlobMedia in Azure", () => {
	it("signs with a user delegation key, reusing it until it nears expiry", async () => {
		const service = blobServiceClient({ kind: "azure", account: "pixelphonedevst" });
		const key: UserDelegationKey = {
			signedObjectId: "00000000-0000-0000-0000-000000000000",
			signedTenantId: "00000000-0000-0000-0000-000000000000",
			signedStartsOn: new Date(),
			signedExpiresOn: new Date(Date.now() + 6 * 3600_000),
			signedService: "b",
			signedVersion: "2025-01-05",
			value: Buffer.alloc(32).toString("base64"),
		};
		const getKey = vi.spyOn(service, "getUserDelegationKey").mockResolvedValue(key as never);
		let now = new Date();
		const media = new BlobMedia(service, "media", "azure", () => now);
		const url = new URL(await media.urlFor("accepted.mp3"));
		expect(url.origin + url.pathname).toBe(
			"https://pixelphonedevst.blob.core.windows.net/media/accepted.mp3",
		);
		expect(url.searchParams.get("spr")).toBe("https");
		expect(url.searchParams.get("sp")).toBe("r");
		expect(url.searchParams.get("skoid")).toBe(key.signedObjectId);
		await media.urlFor("accepted.mp3");
		expect(getKey).toHaveBeenCalledTimes(1);
		now = new Date(now.getTime() + 6 * 3600_000);
		await media.urlFor("accepted.mp3");
		expect(getKey).toHaveBeenCalledTimes(2);
	});
});

describe("NoMedia", () => {
	it("hands out an obviously unusable URL", async () => {
		expect(await new NoMedia().urlFor("accepted.mp3")).toBe("https://media.invalid/accepted.mp3");
		expect(await new NoMedia().exists()).toBe(false);
	});
});

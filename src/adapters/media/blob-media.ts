/**
 * Media on Azure Blob storage (ADR 0008): the private `media` container, read with
 * user-delegation SAS URLs signed by the app's managed identity. No account keys, no
 * public blobs. Each URL is read-only and lasts 15 minutes.
 *
 * Locally (Azurite, by connection string) the URL is signed with Azurite's account key.
 */
import {
	BlobSASPermissions,
	BlobServiceClient,
	generateBlobSASQueryParameters,
	SASProtocol,
	type UserDelegationKey,
} from "@azure/storage-blob";
import type { Media } from "../../core/media.ts";
import { azureCredential, type StorageTarget } from "../storage/clients.ts";

export const SAS_LIFETIME_MS = 15 * 60_000;
/** A delegation key is reused for this long, then fetched again. Azure allows up to 7 days. */
const DELEGATION_KEY_LIFETIME_MS = 6 * 3600_000;
const TIMEOUT_MS = 3_000;

export function blobServiceClient(target: StorageTarget): BlobServiceClient {
	const options = { retryOptions: { maxTries: 2, tryTimeoutInMs: TIMEOUT_MS } };
	if (target.kind === "connection-string") {
		return BlobServiceClient.fromConnectionString(target.connectionString, options);
	}
	return new BlobServiceClient(
		`https://${target.account}.blob.core.windows.net`,
		azureCredential(target.clientId),
		options,
	);
}

export class BlobMedia implements Media {
	private delegation: { key: UserDelegationKey; until: number } | undefined;

	constructor(
		private readonly service: BlobServiceClient,
		private readonly container: string,
		private readonly kind: StorageTarget["kind"],
		private readonly now: () => Date = () => new Date(),
	) {}

	async urlFor(name: string): Promise<string> {
		const blob = this.service.getContainerClient(this.container).getBlobClient(name);
		const now = this.now();
		// A minute of slack for clock skew between us and Azure.
		const startsOn = new Date(now.getTime() - 60_000);
		const expiresOn = new Date(now.getTime() + SAS_LIFETIME_MS);
		const permissions = BlobSASPermissions.parse("r");
		if (this.kind === "connection-string") {
			return blob.generateSasUrl({ permissions, startsOn, expiresOn });
		}
		const key = await this.delegationKey(now);
		const sas = generateBlobSASQueryParameters(
			{
				containerName: this.container,
				blobName: name,
				permissions,
				startsOn,
				expiresOn,
				protocol: SASProtocol.Https,
			},
			key,
			this.service.accountName,
		);
		return `${blob.url}?${sas.toString()}`;
	}

	async exists(name: string): Promise<boolean> {
		return this.service
			.getContainerClient(this.container)
			.getBlobClient(name)
			.exists({ abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
	}

	private async delegationKey(now: Date): Promise<UserDelegationKey> {
		if (this.delegation && this.delegation.until - now.getTime() > SAS_LIFETIME_MS) {
			return this.delegation.key;
		}
		const until = new Date(now.getTime() + DELEGATION_KEY_LIFETIME_MS);
		const key = await this.service.getUserDelegationKey(new Date(now.getTime() - 60_000), until, {
			abortSignal: AbortSignal.timeout(TIMEOUT_MS),
		});
		this.delegation = { key, until: until.getTime() };
		return key;
	}
}

/** Used when no storage is configured: a URL that says so. Telnyx can't fetch it. */
export class NoMedia implements Media {
	async urlFor(name: string): Promise<string> {
		return `https://media.invalid/${encodeURIComponent(name)}`;
	}

	async exists(): Promise<boolean> {
		return false;
	}
}

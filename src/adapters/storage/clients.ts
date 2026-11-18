/**
 * Where pixel-phone's storage lives and how to reach it. In Azure: the storage account by
 * name, with the app's managed identity (shared keys are off). On a laptop: Azurite, by
 * connection string (`UseDevelopmentStorage=true`).
 */
import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export type StorageTarget =
	| { kind: "azure"; account: string; clientId?: string }
	| { kind: "connection-string"; connectionString: string };

let credential: TokenCredential | undefined;

/** One credential for the process, so tokens are cached and shared. */
export function azureCredential(clientId?: string): TokenCredential {
	credential ??= new DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : {});
	return credential;
}

export function tableClient(target: StorageTarget, table: string): TableClient {
	if (target.kind === "connection-string") {
		return TableClient.fromConnectionString(target.connectionString, table, {
			allowInsecureConnection: true,
		});
	}
	return new TableClient(
		`https://${target.account}.table.core.windows.net`,
		table,
		azureCredential(target.clientId),
	);
}

/** True when an Azure SDK error is the HTTP status given. */
export function isStatus(error: unknown, status: number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"statusCode" in error &&
		(error as { statusCode?: unknown }).statusCode === status
	);
}

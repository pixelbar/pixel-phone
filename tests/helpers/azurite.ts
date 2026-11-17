/**
 * Storage adapter tests run against Azurite (`just azurite`). Without it they are skipped
 * on a laptop, and fail in CI, which always starts it.
 */
import { randomBytes } from "node:crypto";
import { connect } from "node:net";

export const AZURITE = "UseDevelopmentStorage=true";

async function reachable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

export const azuriteUp =
	(await reachable(10002)) && (await reachable(10001)) && (await reachable(10000));

if (!azuriteUp && process.env.CI) {
	throw new Error("Azurite isn't running on 127.0.0.1:10000-10002, and CI needs it.");
}

/** A table, queue or container name no other test run uses. */
export function uniqueName(prefix: string): string {
	return `${prefix}${randomBytes(4).toString("hex")}`;
}

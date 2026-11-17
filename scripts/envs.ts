/**
 * The one definition of pixel-phone's Azure environments for the laptop tools: where
 * each lives and which env file it reads. Scripts and `just` recipes take these from
 * here and never spell a resource group, vault or storage account themselves.
 *
 * Pure: nothing here reads a file, the environment or Azure, so it can be tested.
 */

export type Target = "dev" | "prod";

export const TARGETS: readonly Target[] = ["dev", "prod"];

/** The Azure subscription both environments live in. */
export const SUBSCRIPTION = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4";

export type PhoneEnv = {
	target: Target;
	resourceGroup: string;
	/** The Container App, and the value of `PIXEL_PHONE_ENV`. */
	app: string;
	vault: string;
	storageAccount: string;
	/** The laptop env file holding this environment's secrets. */
	envFile: string;
	/** Changes here reach the real doorbell, so tools ask harder before writing. */
	prod: boolean;
};

export const ENVS: Readonly<Record<Target, PhoneEnv>> = {
	dev: {
		target: "dev",
		resourceGroup: "pixel-phone-dev",
		app: "pixel-phone-dev",
		vault: "pixel-phone-dev-kv",
		storageAccount: "pixelphonedevst",
		envFile: ".env.dev",
		prod: false,
	},
	prod: {
		target: "prod",
		resourceGroup: "pixel-phone-prod",
		app: "pixel-phone-prod",
		vault: "pixel-phone-prod-kv",
		storageAccount: "pixelphoneprodst",
		envFile: ".env.prod",
		prod: true,
	},
};

/** Reads a target from a command-line argument, or explains what it should be. */
export function parseTarget(value: string | undefined): Target {
	if (value === "dev" || value === "prod") return value;
	throw new Error(`Expected dev or prod, got ${value === undefined ? "nothing" : `"${value}"`}.`);
}

// The accept API's spec, parsed from docs/openapi.yaml at build time (see `openapiSpec` in config.ts).
declare module "virtual:pixel-phone-openapi" {
	const spec: Record<string, unknown>;
	export default spec;
}

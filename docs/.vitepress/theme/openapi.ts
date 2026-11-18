import type { App, Component } from "vue";

let loading: Promise<Component> | undefined;

/**
 * Loads vitepress-openapi, its styles and the spec once, registers the library's
 * components and i18n on the app, and returns its <OASpec>. Later visits to the
 * page reuse the first load.
 */
export function load(app: App): Promise<Component> {
	loading ??= (async () => {
		const [{ OASpec, theme, useOpenapi, usePlayground }, { default: spec }] = await Promise.all([
			import("vitepress-openapi/client"),
			import("virtual:pixel-phone-openapi"),
		]);
		// Pixel's overrides must come after the library's own styles.
		await import("vitepress-openapi/dist/style.css");
		await import("./openapi.css");

		useOpenapi({
			spec,
			config: {
				// Schemas open on arrival rather than a tree to click through.
				schemaViewer: { deep: Number.POSITIVE_INFINITY },
				// The library's attribution sits in the site footer instead.
				operation: { hiddenSlots: ["branding"] },
			},
		});
		// Otherwise the samples show a bare "Token". Keys come from `just api-key`.
		usePlayground().setSecuritySchemeDefaultValues({
			"http-bearer": "Bearer <your-api-key>",
		});
		// Theme.enhanceApp only reads `app`; the rest of VitePress's context isn't needed.
		await theme.enhanceApp({ app } as Parameters<typeof theme.enhanceApp>[0]);
		return OASpec as Component;
	})();
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}

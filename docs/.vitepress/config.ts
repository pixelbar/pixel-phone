import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { parse } from "yaml";
import { escapeMustache } from "./markdown/escape-mustache";
import { mermaidFence } from "./markdown/mermaid";
import { repoLinks } from "./markdown/repo-links";

const REPO = "https://github.com/pixelbar/pixel-phone";
const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(docsDir, "..");
const OPENAPI_MODULE = "virtual:pixel-phone-openapi";
/** Notes for people and agents working on the site, not pages. */
const NOT_PAGES = ["AGENTS.md"];

/** pixel-phone's own version, shown in the nav once it has been released. */
function appVersion(): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
		return typeof pkg.version === "string" && pkg.version !== "0.0.0" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}
const version = appVersion();

/**
 * Where the site is served from. GitHub Pages serves a project site under
 * /<repo>/ (pixelbar.nl/pixel-phone/), so the Pages workflow sets DOCS_BASE;
 * locally it's the root.
 */
const base = normaliseBase(process.env.DOCS_BASE);
function normaliseBase(value: string | undefined): string {
	const trimmed = (value ?? "").replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}/` : "/";
}

/** Every ADR in docs/adr/, titled from its first heading (`# 0002. Answer only on accept`). */
function adrs(): { text: string; link: string }[] {
	const dir = resolve(docsDir, "adr");
	return readdirSync(dir)
		.filter((file) => /^\d{4}-.+\.md$/.test(file))
		.sort()
		.map((file) => {
			const heading = readFileSync(resolve(dir, file), "utf8").match(/^# (\d{4})\. (.+)$/m);
			const name = file.replace(/\.md$/, "");
			return {
				text: heading ? `${heading[1]} · ${heading[2]}` : name,
				link: `/adr/${name}`,
			};
		});
}

export default defineConfig({
	base,
	lang: "en",
	title: "pixel-phone",
	titleTemplate: ":title · pixel-phone",
	description: "Answers the Pixelbar doorbell: rings the space, and picks up when someone accepts.",
	cleanUrls: true,
	srcExclude: NOT_PAGES,
	lastUpdated: true,
	// Follow the system on the first visit, then remember the person's choice.
	appearance: true,

	head: [
		["meta", { name: "theme-color", content: "#06060b" }],
		[
			"link",
			{
				rel: "icon",
				href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2306060b'/%3E%3Crect x='1' y='1' width='3' height='3' fill='%23ff3dd6'/%3E%3Crect x='4' y='4' width='3' height='3' fill='%2300e5ff'/%3E%3C/svg%3E",
			},
		],
	],

	markdown: {
		config(md) {
			md.use(escapeMustache);
			md.use(mermaidFence);
			md.use(repoLinks, { repo: REPO, repoRoot, docsDir, notPages: NOT_PAGES });
		},
	},

	vite: {
		plugins: [
			// docs/openapi.yaml is the accept API's single source (a test checks it against
			// the routes). The theme imports it as `virtual:pixel-phone-openapi`, parsed
			// here, so nothing is generated into the tree and the browser never parses YAML.
			{
				name: "pixel-phone-openapi",
				resolveId: (source) => (source === OPENAPI_MODULE ? `\0${OPENAPI_MODULE}` : undefined),
				load(id) {
					if (id !== `\0${OPENAPI_MODULE}`) return undefined;
					const file = resolve(docsDir, "openapi.yaml");
					this.addWatchFile(file);
					return `export default ${JSON.stringify(parse(readFileSync(file, "utf8")))};`;
				},
			},
		],
		// Mermaid is big, but it's split out and only loaded on pages with a diagram.
		build: { chunkSizeWarningLimit: 1600 },
		// vitepress-openapi ships Vue components that must go through Vite's SSR build.
		ssr: { noExternal: ["vitepress-openapi"] },
	},

	themeConfig: {
		siteTitle: "pixel-phone",

		nav: [
			{ text: "Overview", link: "/" },
			{ text: "Accept API", link: "/accept-api" },
			{ text: "Runbook", link: "/runbook" },
			{ text: "Pixelbar", link: "https://pixelbar.nl/" },
			...(version ? [{ text: `v${version}`, link: `${REPO}/blob/main/CHANGELOG.md` }] : []),
		],

		sidebar: [
			{
				text: "pixel-phone",
				items: [
					{ text: "Overview", link: "/" },
					{ text: "Architecture", link: "/architecture" },
					{ text: "Infrastructure", link: "/infra" },
				],
			},
			{
				text: "Integrations",
				items: [
					{ text: "Accept API", link: "/accept-api" },
					{ text: "Call events for Pixel", link: "/events" },
					{ text: "Home Assistant", link: "/home-assistant" },
				],
			},
			{
				text: "Operations",
				items: [{ text: "Runbook", link: "/runbook" }],
			},
			{ text: "Decisions", collapsed: false, items: adrs() },
		],

		outline: { level: [2, 3], label: "On this page" },
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: REPO }],
		editLink: {
			pattern: `${REPO}/edit/main/docs/:path`,
			text: "Edit this page on GitHub",
		},
		footer: {
			message:
				'A <a href="https://pixelbar.nl">Pixelbar</a> project · themed after <a href="https://pixelbar.nl/pixel">pixelbar.nl/pixel</a>',
			copyright: "Pixelbar hackerspace, Rotterdam",
		},
	},
});

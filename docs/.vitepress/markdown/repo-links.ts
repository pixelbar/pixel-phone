import { statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { MarkdownRenderer } from "vitepress";

type Options = {
	/** The GitHub repository, e.g. https://github.com/pixelbar/pixel-phone */
	repo: string;
	/** Absolute path of the repository root. */
	repoRoot: string;
	/** Absolute path of the VitePress source directory (docs/). */
	docsDir: string;
	/** Markdown files in docs/ that aren't pages (VitePress's srcExclude), e.g. `AGENTS.md`. */
	notPages: string[];
};

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/**
 * The docs link to files elsewhere in the repository (`../src/…`, `../README.md`,
 * `../infra/bootstrap`) and to files in docs/ that aren't pages (`openapi.yaml`,
 * `events.schema.json`). Those aren't part of the site, so point them at the file
 * on GitHub instead of leaving a dead link. Links between pages (`*.md` in docs/)
 * are left to VitePress. Copied from Pixel's docs/.vitepress/markdown/repo-links.ts.
 */
export function repoLinks(
	md: MarkdownRenderer,
	{ repo, repoRoot, docsDir, notPages }: Options,
): void {
	md.core.ruler.push("pixel_phone_repo_links", (state) => {
		const file: unknown = state.env?.realPath ?? state.env?.path;
		if (typeof file !== "string") return;
		for (const block of state.tokens) {
			for (const token of block.children ?? []) {
				if (token.type !== "link_open") continue;
				const href = token.attrGet("href");
				if (!href || EXTERNAL.test(href)) continue;

				const [path = "", hash] = href.split("#");
				const target = resolve(dirname(file), decodeURI(path));
				const inDocs = relative(docsDir, target).split(sep).join("/");
				const page = !inDocs.startsWith("..") && !notPages.includes(inDocs);
				if (page && (path === "" || path.endsWith(".md"))) continue;

				const fromRoot = relative(repoRoot, target).split(sep).join("/");
				if (fromRoot.startsWith("..")) continue;
				const kind = isDirectory(target) ? "tree" : "blob";
				token.attrSet("href", `${repo}/${kind}/main/${fromRoot}${hash ? `#${hash}` : ""}`);
			}
		}
	});
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

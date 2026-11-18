import type { MarkdownRenderer } from "vitepress";

/**
 * ```mermaid fences become the <Mermaid> component (theme/Mermaid.vue), which
 * draws the diagram in the browser in the Pixel colours and redraws it when the
 * colour mode flips. The source travels URI-encoded so Vue never reads braces in
 * it as template syntax.
 */
export function mermaidFence(md: MarkdownRenderer): void {
	const fence = md.renderer.rules.fence;
	md.renderer.rules.fence = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		if (token && token.info.trim() === "mermaid") {
			return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
		}
		return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
	};
}

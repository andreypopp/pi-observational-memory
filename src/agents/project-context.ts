import { estimateStringTokens } from "../tokens.js";

/** A context file as Pi loads it (AGENTS.md, CLAUDE.md, the global ~/.pi/agent/AGENTS.md). */
export type ProjectContextFile = { path: string; content: string };

export type RenderedProjectContext = {
	/** The data block for the reflector calls; "" when there are no files. */
	text: string;
	/** Files rendered in full. */
	fileCount: number;
	estimatedTokens: number;
	/** Files left out to stay within the cap, with their estimated size. */
	omitted: { path: string; tokens: number }[];
};

const HEADER = "PROJECT INSTRUCTIONS (loaded into every session of this project; reference only):";

export function isProjectContextFile(value: unknown): value is ProjectContextFile {
	return !!value && typeof value === "object"
		&& typeof (value as { path?: unknown }).path === "string"
		&& typeof (value as { content?: unknown }).content === "string";
}

function fileBlock(file: ProjectContextFile): string {
	return `### ${file.path}\n${file.content.trimEnd()}`;
}

/**
 * Render context files for the reflector, whole files only, within `maxTokens`.
 *
 * Pi orders files from the global one to the one nearest the cwd, so the budget fills from the
 * last (most specific) file backwards. Kept files render in their original order; omitted ones
 * are listed by path so the reflector knows they exist.
 */
export function renderProjectContext(files: readonly ProjectContextFile[], maxTokens: number): RenderedProjectContext {
	if (files.length === 0) return { text: "", fileCount: 0, estimatedTokens: 0, omitted: [] };
	const blocks = files.map(fileBlock);
	const tokens = blocks.map(estimateStringTokens);
	const kept = new Set<number>();
	let used = 0;
	for (let i = files.length - 1; i >= 0; i--) {
		if (used + tokens[i] > maxTokens) continue;
		kept.add(i);
		used += tokens[i];
	}
	const omitted = files.flatMap((file, i) => (kept.has(i) ? [] : [{ path: file.path, tokens: tokens[i] }]));
	const sections = blocks.filter((_block, i) => kept.has(i));
	if (omitted.length > 0) sections.push(omitted.map((file) => `(omitted: ${file.path}, ~${file.tokens} tokens)`).join("\n"));
	const text = `${HEADER}\n\n${sections.join("\n\n")}`;
	return { text, fileCount: kept.size, estimatedTokens: estimateStringTokens(text), omitted };
}

/** Prepend the project context block to a reflector call's user text; unchanged when it is empty. */
export function withProjectContext(projectContext: string | undefined, userText: string): string {
	return projectContext ? `${projectContext}\n\n${userText}` : userText;
}

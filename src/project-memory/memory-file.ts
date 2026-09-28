import { existsSync, readFileSync } from "node:fs";
import { hashId } from "../ids.js";
import { estimateStringTokens } from "../tokens.js";

export const MEMORY_FILE_NAME = ".memory.md";
const TITLE = "# Promoted memory";
const INTRO = "Durable facts promoted from observational memory. `recall <id>` shows the evidence behind a line.";

const ID_LINE = /^- \[([a-f0-9]{12})\] (.+)$/;

export type BlockLine = {
	/** The line's memory id, or a content hash for a hand-written line without one. */
	id: string;
	content: string;
	/** The line exactly as it stands in the file, without its line ending. */
	raw: string;
	/** False for hand-written lines without an `[id]` prefix: no `.memory/` record backs them. */
	hasId: boolean;
};

export type ParsedPromotedMemory = {
	lines: BlockLine[];
	/** Other text besides the header: not kept when OM rewrites the file. */
	dropped: string[];
};

/**
 * Parse `.memory.md`. The file is OM's: `- ` lines are promoted lines (`- [id] content` ones linked to
 * `.memory/`), the fixed header is skipped, and any other text is reported as dropped.
 */
export function parsePromotedMemory(content: string): ParsedPromotedMemory {
	const lines: BlockLine[] = [];
	const dropped: string[] = [];
	for (const raw of content.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.replace(/\s+$/, ""))) {
		const text = raw.trim();
		if (!text || text === TITLE || text === INTRO) continue;
		const match = ID_LINE.exec(text);
		if (match) {
			lines.push({ id: match[1], content: match[2].trim(), raw, hasId: true });
			continue;
		}
		const bullet = /^- +(.+)$/.exec(text);
		if (bullet) lines.push({ id: hashId(bullet[1]), content: bullet[1], raw, hasId: false });
		else dropped.push(text);
	}
	return { lines, dropped };
}

/** `.memory.md`'s raw text, or undefined when there is no file. */
export function readPromotedMemory(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function renderBlockLine(id: string, content: string): string {
	return `- [${id}] ${content}`;
}

/** The whole `.memory.md` for these lines: the fixed header, then one line each. */
export function renderPromotedMemory(lines: readonly string[]): string {
	return `${[TITLE, "", INTRO, "", ...lines].join("\n")}\n`;
}

export function blockTokens(lines: readonly string[]): number {
	return estimateStringTokens(renderPromotedMemory(lines));
}

import { hashId } from "../ids.js";
import { estimateStringTokens } from "../tokens.js";

export const PROMOTED_START = "<!-- om:promoted:start -->";
export const PROMOTED_END = "<!-- om:promoted:end -->";
const HEADING = "## Promoted memory";
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

export type ParsedContextFile = {
	/** The file content with markers absent, or with the block cut out (for showing the rest to the model). */
	outside: string;
	hasBlock: boolean;
	lines: BlockLine[];
	eol: "\n" | "\r\n";
	/** Start and end offsets of the managed block, markers included. */
	range?: { start: number; end: number };
};

export class BlockMarkerError extends Error {}

function eolOf(content: string): "\n" | "\r\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function parseLine(raw: string): BlockLine | undefined {
	const text = raw.trim();
	if (!text || text === HEADING || text === INTRO) return undefined;
	const match = ID_LINE.exec(text);
	if (match) return { id: match[1], content: match[2].trim(), raw, hasId: true };
	const content = text.replace(/^[-*]\s+/, "");
	return { id: hashId(content), content, raw, hasId: false };
}

/**
 * Parse the managed block of a context file. Only text between the markers belongs to OM; lines there
 * other than the heading and intro are block lines, `- [id] content` ones linked to `.memory/`.
 * Throws BlockMarkerError when the markers are unbalanced, so a broken block is never overwritten.
 */
export function parseContextFile(content: string): ParsedContextFile {
	const eol = eolOf(content);
	const start = content.indexOf(PROMOTED_START);
	const end = content.indexOf(PROMOTED_END);
	if (start === -1 && end === -1) return { outside: content, hasBlock: false, lines: [], eol };
	if (start === -1 || end === -1 || end < start || content.indexOf(PROMOTED_START, start + 1) !== -1 || content.indexOf(PROMOTED_END, end + 1) !== -1) {
		throw new BlockMarkerError(`the ${PROMOTED_START} / ${PROMOTED_END} markers are unbalanced`);
	}
	const inner = content.slice(start + PROMOTED_START.length, end);
	const lines = inner.split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).flatMap((raw) => parseLine(raw) ?? []);
	const blockEnd = end + PROMOTED_END.length;
	return {
		outside: `${content.slice(0, start)}${content.slice(blockEnd)}`,
		hasBlock: true,
		lines,
		eol,
		range: { start, end: blockEnd },
	};
}

export function renderBlockLine(id: string, content: string): string {
	return `- [${id}] ${content}`;
}

/** The managed block, markers included, without a trailing line ending. */
export function renderBlock(lines: readonly string[], eol: "\n" | "\r\n" = "\n"): string {
	return [PROMOTED_START, HEADING, INTRO, "", ...lines, PROMOTED_END].join(eol);
}

export function blockTokens(lines: readonly string[]): number {
	return estimateStringTokens(renderBlock(lines));
}

/**
 * Replace the managed block in `content`, or append it after a blank line when the file has none.
 * `parsed` must be `content` already parsed, when the caller has it.
 */
export function replaceBlock(content: string, lines: readonly string[], parsed: ParsedContextFile = parseContextFile(content)): string {
	const block = renderBlock(lines, parsed.eol);
	if (parsed.range) return `${content.slice(0, parsed.range.start)}${block}${content.slice(parsed.range.end)}`;
	const { eol } = parsed;
	if (content.length === 0) return `${block}${eol}`;
	const body = content.endsWith("\n") ? content : `${content}${eol}`;
	const separator = /(\r?\n){2}$/.test(body) ? "" : eol;
	return `${body}${separator}${block}${eol}`;
}

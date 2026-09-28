import { truncateRecordContent } from "../serialize.js";

/** Newline-joined items, or a placeholder when there are none. */
export function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

/** Trimmed, truncated single-line record content; undefined when empty or multi-line. */
export function normalizeContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

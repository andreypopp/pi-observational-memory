import { closeSync, type Dirent, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashId } from "../ids.js";
import { isMemoryId, isRelevance, type Relevance } from "../session-ledger/types.js";
import { MEMORY_DIR_NAME } from "./target.js";

/** A reflection or observation as stored in `.memory/<id>.md`. */
export type MemoryRecord =
	| {
			kind: "reflection";
			id: string;
			content: string;
			session?: string;
			replaces?: string[];
			supportingObservationIds: string[];
			promotedAt?: string;
	  }
	| {
			kind: "observation";
			id: string;
			content: string;
			timestamp: string;
			relevance: Relevance;
			session?: string;
			sourceEntryIds: string[];
	  };

export type ParsedMemoryFile = MemoryRecord & {
	/** False when the body no longer hashes to the id: the text was edited since promotion. */
	bodyMatchesId: boolean;
};

export const LINKS_MARKER = "<!-- om:links -->";

export const SESSION_ID_PATTERN = /^[0-9a-f-]{32,36}$/;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Frontmatter scalars are single-line; content never goes there. */
function scalar(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

function idList(ids: readonly string[]): string {
	return `[${ids.join(", ")}]`;
}

function linkList(ids: readonly string[]): string {
	return ids.map((id) => `[${id}](${id}.md)`).join(", ");
}

/** Render a memory file: small frontmatter, the content verbatim, then relative links for reading. */
export function renderMemoryFile(record: MemoryRecord): string {
	const fields: string[] = [`id: ${record.id}`, `kind: ${record.kind}`];
	if (record.kind === "reflection") {
		if (record.session) fields.push(`session: ${scalar(record.session)}`);
		if (record.replaces && record.replaces.length > 0) fields.push(`replaces: ${idList(record.replaces)}`);
		fields.push(`supportingObservationIds: ${idList(record.supportingObservationIds)}`);
		if (record.promotedAt) fields.push(`promotedAt: ${scalar(record.promotedAt)}`);
	} else {
		fields.push(`timestamp: ${scalar(record.timestamp)}`, `relevance: ${record.relevance}`);
		if (record.session) fields.push(`session: ${scalar(record.session)}`);
		fields.push(`sourceEntryIds: ${idList(record.sourceEntryIds)}`);
	}
	const head = `---\n${fields.join("\n")}\n---\n${record.content}\n`;
	if (record.kind === "observation") return head;
	const links = [`- recall: \`recall ${record.id}\``];
	if (record.replaces && record.replaces.length > 0) links.push(`- replaces: ${linkList(record.replaces)}`);
	links.push(`- evidence: ${linkList(record.supportingObservationIds)}`);
	return `${head}\n${LINKS_MARKER}\n${links.join("\n")}\n`;
}

function parseIdList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const match = /^\[(.*)\]$/.exec(value.trim());
	if (!match) return undefined;
	const items = match[1].split(",").map((item) => item.trim()).filter(Boolean);
	return items;
}

/**
 * Parse a memory file OM wrote. The body is the text between the frontmatter and the links marker (or
 * EOF) after CRLF normalisation, minus the one line ending that separates it from what follows.
 * Returns undefined for anything that is not a well-formed record.
 */
export function parseMemoryFile(text: string): ParsedMemoryFile | undefined {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return undefined;
	const close = normalized.indexOf("\n---\n", 3);
	if (close === -1) return undefined;
	const fields = new Map<string, string>();
	for (const line of normalized.slice(4, close).split("\n")) {
		const match = /^([A-Za-z]+):\s?(.*)$/.exec(line);
		if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
	}
	const rest = normalized.slice(close + 5);
	const linksAt = rest.lastIndexOf(`\n${LINKS_MARKER}`);
	const beforeLinks = linksAt === -1 ? rest : rest.slice(0, linksAt + 1);
	// The writer ends the body with one newline, plus a blank line before the links block.
	const body = linksAt !== -1 && beforeLinks.endsWith("\n\n") ? beforeLinks.slice(0, -2) : beforeLinks.replace(/\n$/, "");
	const id = fields.get("id");
	if (!isMemoryId(id) || body.length === 0) return undefined;
	const session = fields.get("session");
	const sessionField = session && SESSION_ID_PATTERN.test(session) ? { session } : {};
	const bodyMatchesId = hashId(body) === id;
	if (fields.get("kind") === "reflection") {
		const supportingObservationIds = parseIdList(fields.get("supportingObservationIds"))?.filter(isMemoryId) ?? [];
		const replaces = parseIdList(fields.get("replaces"))?.filter(isMemoryId) ?? [];
		const promotedAt = fields.get("promotedAt");
		return {
			kind: "reflection",
			id,
			content: body,
			...sessionField,
			...(replaces.length > 0 ? { replaces } : {}),
			supportingObservationIds,
			...(promotedAt ? { promotedAt } : {}),
			bodyMatchesId,
		};
	}
	if (fields.get("kind") === "observation") {
		const relevance = fields.get("relevance");
		const timestamp = fields.get("timestamp");
		if (!isRelevance(relevance) || !timestamp) return undefined;
		const sourceEntryIds = parseIdList(fields.get("sourceEntryIds"))?.filter((entryId) => ENTRY_ID_PATTERN.test(entryId)) ?? [];
		return { kind: "observation", id, content: body, timestamp, relevance, ...sessionField, sourceEntryIds, bodyMatchesId };
	}
	return undefined;
}

export function memoryFilePath(memoryDir: string, id: string): string {
	if (!isMemoryId(id)) throw new Error(`invalid memory id: ${id}`);
	return join(memoryDir, `${id}.md`);
}

export function readMemoryRecord(memoryDir: string, id: string): ParsedMemoryFile | undefined {
	if (!isMemoryId(id)) return undefined;
	try {
		return parseMemoryFile(readFileSync(memoryFilePath(memoryDir, id), "utf8"));
	} catch {
		return undefined;
	}
}

export function memoryFileExists(memoryDir: string, id: string): boolean {
	return isMemoryId(id) && existsSync(memoryFilePath(memoryDir, id));
}

/**
 * Write each record as a new file; an existing file is never rewritten (ids are content hashes).
 * Returns the ids written.
 */
export function writeNewMemoryFiles(memoryDir: string, records: readonly MemoryRecord[]): string[] {
	const written: string[] = [];
	if (records.length === 0) return written;
	mkdirSync(memoryDir, { recursive: true });
	for (const record of records) {
		let fd: number;
		try {
			fd = openSync(memoryFilePath(memoryDir, record.id), "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		try {
			writeSync(fd, renderMemoryFile(record));
		} finally {
			closeSync(fd);
		}
		written.push(record.id);
	}
	return written;
}

function isRegularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** Ids of the regular `<id>.md` files in `memoryDir`; other names, subdirectories and symlinks are left out. */
export function listMemoryFileIds(memoryDir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(memoryDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.slice(0, -3))
		.filter(isMemoryId)
		.sort();
}

/** Remove the regular `<id>.md` file of each id; one that vanished or is not a regular file is skipped. Returns the ids removed. */
export function removeMemoryFiles(memoryDir: string, ids: readonly string[]): string[] {
	const removed: string[] = [];
	for (const id of ids) {
		if (!isMemoryId(id)) continue;
		const path = memoryFilePath(memoryDir, id);
		if (!isRegularFile(path)) continue;
		try {
			rmSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		removed.push(id);
	}
	return removed;
}

/** `.memory/` directories that may hold project memory for `cwd`: each ancestor's, nearest first, then `extra`. */
export function memoryDirCandidates(cwd: string, extra: readonly string[] = []): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	while (true) {
		dirs.push(join(dir, MEMORY_DIR_NAME));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const candidate of extra) if (!dirs.includes(candidate)) dirs.push(candidate);
	return dirs;
}

/** The nearest `.memory/` directory holding a file for `id`. */
export function findMemoryDirFor(candidates: readonly string[], id: string): string | undefined {
	return candidates.find((memoryDir) => memoryFileExists(memoryDir, id));
}

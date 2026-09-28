import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Entry } from "../session-ledger/types.js";
import { SESSION_ID_PATTERN } from "./store.js";

/** Bytes read from one session file at most when looking up another session's source entries. */
export const SESSION_FILE_READ_CAP_BYTES = 64 * 1024 * 1024;

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The session file of `sessionId` among the project's session directories: the current one first, then
 * every sibling under the same sessions root (Pi names files `<timestamp>_<sessionId>.jsonl`).
 */
export function findSessionFile(sessionDir: string, sessionId: string): string | undefined {
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	const suffix = `_${sessionId}.jsonl`;
	const root = dirname(sessionDir);
	const dirs = [sessionDir, ...listDir(root).map((name) => join(root, name)).filter((dir) => dir !== sessionDir && isDirectory(dir))];
	for (const dir of dirs) {
		const file = listDir(dir).find((name) => name.endsWith(suffix));
		if (file) return join(dir, file);
	}
	return undefined;
}

function readHead(path: string, fileSize: number, maxBytes: number): string {
	const fd = openSync(path, "r");
	try {
		const size = Math.min(fileSize, maxBytes);
		const buffer = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const read = readSync(fd, buffer, offset, size - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** The last session file read, so repeated recalls from one session read it once; a single entry bounds memory. */
let lastRead: { path: string; mtimeMs: number; size: number; maxBytes: number; text: string } | undefined;

function readHeadCached(path: string, maxBytes: number): string {
	const { mtimeMs, size } = statSync(path);
	if (lastRead && lastRead.path === path && lastRead.mtimeMs === mtimeMs && lastRead.size === size && lastRead.maxBytes === maxBytes) return lastRead.text;
	const text = readHead(path, size, maxBytes);
	lastRead = { path, mtimeMs, size, maxBytes, text };
	return text;
}

/** Read only the entries with the given ids from a session file, within the byte cap. */
export function readSessionEntries(path: string, entryIds: ReadonlySet<string>, maxBytes = SESSION_FILE_READ_CAP_BYTES): Entry[] {
	const found: Entry[] = [];
	if (entryIds.size === 0) return found;
	let text: string;
	try {
		text = readHeadCached(path, maxBytes);
	} catch {
		return found;
	}
	const wanted = Array.from(entryIds);
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		// Cheap pre-check before parsing: the line must mention one of the wanted ids.
		if (!wanted.some((id) => line.includes(`"${id}"`))) continue;
		try {
			const entry = JSON.parse(line) as Entry;
			if (entry && typeof entry === "object" && typeof entry.id === "string" && entryIds.has(entry.id) && !seen.has(entry.id)) {
				seen.add(entry.id);
				found.push(entry);
				if (seen.size === entryIds.size) break;
			}
		} catch {
			// A truncated last line or foreign content: skip.
		}
	}
	return found;
}

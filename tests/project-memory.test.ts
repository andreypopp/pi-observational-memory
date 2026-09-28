import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hashId } from "../src/ids.js";
import { promotedLineTokens, parsePromotedMemory, renderPromotedLine, renderPromotedMemory } from "../src/project-memory/memory-file.js";
import { memoryClosure } from "../src/project-memory/closure.js";
import { findSessionFile, readSessionEntries } from "../src/project-memory/sessions.js";
import {
	findMemoryDirFor,
	listMemoryFileIds,
	memoryDirCandidates,
	parseMemoryFile,
	readMemoryRecord,
	removeMemoryFiles,
	renderMemoryFile,
	writeNewMemoryFiles,
	type MemoryRecord,
} from "../src/project-memory/store.js";
import { resolvePromoteTarget } from "../src/project-memory/target.js";
import { observation, reflection } from "./fixtures/session.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "om-promote-")));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REF_CONTENT = "Throwaway tmux servers must be addressed with -S <resolved path>, never -L.";
const REF_ID = hashId(REF_CONTENT);
const OBS_CONTENT = "User said: never use -L\nfor throwaway servers.";
const OBS_ID = hashId(OBS_CONTENT);
const SESSION = "01a0bfcf-d4de-739b-b7dd-5feda3a16ab8";

describe(".memory.md", () => {
	it("renders a fixed header and one line each, and round-trips", () => {
		const lines = [renderPromotedLine(REF_ID, REF_CONTENT)];
		const content = renderPromotedMemory(lines);

		expect(content).toBe(`# Promoted memory\n\nDurable facts promoted from observational memory. \`recall <id>\` shows the evidence behind a line.\n\n${lines[0]}\n`);
		expect(parsePromotedMemory(content)).toEqual({ lines: [{ id: REF_ID, content: REF_CONTENT, raw: lines[0], hasId: true }], dropped: [] });
	});

	it("keeps hand-edited lines: an id keeps its edited text, a `- ` line without id gets a content hash", () => {
		const content = `\uFEFF# Promoted memory\r\n- [${REF_ID}] edited by hand  \r\n- Written without an id\r\n\r\n`;

		expect(parsePromotedMemory(content).lines).toEqual([
			{ id: REF_ID, content: "edited by hand", raw: `- [${REF_ID}] edited by hand`, hasId: true },
			{ id: hashId("Written without an id"), content: "Written without an id", raw: "- Written without an id", hasId: false },
		]);
	});

	it("reports any other text as dropped", () => {
		const parsed = parsePromotedMemory(`# Promoted memory\n\n## Notes\nA paragraph.\n* star bullet\n- [${REF_ID}] kept\n`);

		expect(parsed.lines.map((line) => line.id)).toEqual([REF_ID]);
		expect(parsed.dropped).toEqual(["## Notes", "A paragraph.", "* star bullet"]);
	});

	it("counts the whole rendered file in the token estimate", () => {
		expect(promotedLineTokens([])).toBe(Math.ceil(renderPromotedMemory([]).length / 4));
	});
});

describe("promote target", () => {
	it("uses .memory.md at the repository root, whatever context files exist", () => {
		const root = tempDir();
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(root, "pkg", "sub"), { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "agents");
		expect(resolvePromoteTarget(join(root, "pkg", "sub"))).toEqual({
			root,
			memoryPath: join(root, ".memory.md"),
			memoryDir: join(root, ".memory"),
		});
	});

	it("uses cwd outside git", () => {
		const dir = tempDir();
		expect(resolvePromoteTarget(dir)).toEqual({ root: dir, memoryPath: join(dir, ".memory.md"), memoryDir: join(dir, ".memory") });
	});

	it("targets the main worktree from a linked worktree", () => {
		const base = tempDir();
		const main = join(base, "main");
		const linked = join(base, "feature");
		mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
		writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(main, ".git", "worktrees", "feature", "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
		mkdirSync(linked);
		writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
		writeFileSync(join(linked, ".memory.md"), "worktree copy");

		expect(resolvePromoteTarget(linked)).toEqual({
			root: main,
			memoryPath: join(main, ".memory.md"),
			memoryDir: join(main, ".memory"),
			linkedWorktreeRoot: linked,
		});
	});
});

describe(".memory store", () => {
	const reflectionRecord: MemoryRecord = {
		kind: "reflection",
		id: REF_ID,
		content: REF_CONTENT,
		session: SESSION,
		replaces: ["837779b4d48b", "bb136694d4c2"],
		supportingObservationIds: [OBS_ID],
		promotedAt: "2026-09-28T16:10:00.000Z",
	};
	const observationRecord: MemoryRecord = {
		kind: "observation",
		id: OBS_ID,
		content: OBS_CONTENT,
		timestamp: "2026-09-27 00:46",
		relevance: "critical",
		session: SESSION,
		sourceEntryIds: ["9c1e22f0", "4ab7d013"],
	};

	it("renders the documented layout", () => {
		expect(renderMemoryFile(reflectionRecord)).toBe([
			"---",
			`id: ${REF_ID}`,
			"kind: reflection",
			`session: ${SESSION}`,
			"replaces: [837779b4d48b, bb136694d4c2]",
			`supportingObservationIds: [${OBS_ID}]`,
			"promotedAt: 2026-09-28T16:10:00.000Z",
			"---",
			REF_CONTENT,
			"",
			"<!-- om:links -->",
			`- recall: \`recall ${REF_ID}\``,
			"- replaces: [837779b4d48b](837779b4d48b.md), [bb136694d4c2](bb136694d4c2.md)",
			`- evidence: [${OBS_ID}](${OBS_ID}.md)`,
			"",
		].join("\n"));
		expect(renderMemoryFile(observationRecord)).toBe(`---\nid: ${OBS_ID}\nkind: observation\ntimestamp: 2026-09-27 00:46\nrelevance: critical\nsession: ${SESSION}\nsourceEntryIds: [9c1e22f0, 4ab7d013]\n---\n${OBS_CONTENT}\n`);
	});

	it("round-trips reflections and multi-line observations, also through CRLF", () => {
		expect(parseMemoryFile(renderMemoryFile(reflectionRecord))).toEqual({ ...reflectionRecord, bodyMatchesId: true });
		expect(parseMemoryFile(renderMemoryFile(observationRecord))).toEqual({ ...observationRecord, bodyMatchesId: true });
		expect(parseMemoryFile(renderMemoryFile(observationRecord).replace(/\n/g, "\r\n"))).toEqual({ ...observationRecord, bodyMatchesId: true });
	});

	it("notes an edited body and ignores invalid session ids", () => {
		const edited = renderMemoryFile(reflectionRecord).replace(REF_CONTENT, "Edited text").replace(SESSION, "../../etc");
		const parsed = parseMemoryFile(edited)!;
		expect(parsed.content).toBe("Edited text");
		expect(parsed.bodyMatchesId).toBe(false);
		expect(parsed).not.toHaveProperty("session");
		expect(parseMemoryFile("no frontmatter")).toBeUndefined();
		expect(parseMemoryFile("---\nid: nothex\nkind: reflection\n---\nx\n")).toBeUndefined();
	});

	it("writes new files only and never rewrites an existing one", () => {
		const dir = join(tempDir(), ".memory");
		expect(writeNewMemoryFiles(dir, [reflectionRecord])).toEqual([REF_ID]);
		writeFileSync(join(dir, `${REF_ID}.md`), "hand edited");
		expect(writeNewMemoryFiles(dir, [reflectionRecord, observationRecord])).toEqual([OBS_ID]);
		expect(readFileSync(join(dir, `${REF_ID}.md`), "utf8")).toBe("hand edited");
		expect(readMemoryRecord(dir, OBS_ID)?.content).toBe(OBS_CONTENT);
		expect(readMemoryRecord(dir, "../../x")).toBeUndefined();
	});

	it("finds the nearest .memory directory holding an id", () => {
		const root = tempDir();
		const nested = join(root, "a", "b");
		mkdirSync(join(nested, ".memory"), { recursive: true });
		writeNewMemoryFiles(join(root, ".memory"), [observationRecord]);
		const candidates = memoryDirCandidates(nested);
		expect(candidates.slice(0, 3)).toEqual([join(nested, ".memory"), join(root, "a", ".memory"), join(root, ".memory")]);
		expect(findMemoryDirFor(candidates, OBS_ID)).toBe(join(root, ".memory"));
		writeNewMemoryFiles(join(nested, ".memory"), [observationRecord]);
		expect(findMemoryDirFor(candidates, OBS_ID)).toBe(join(nested, ".memory"));
	});

	it("lists only regular <id>.md files, and removes only those", () => {
		const root = tempDir();
		const dir = join(root, ".memory");
		expect(listMemoryFileIds(dir)).toEqual([]);
		writeNewMemoryFiles(dir, [observationRecord]);
		writeFileSync(join(dir, "README.md"), "readme");
		writeFileSync(join(dir, ".gitkeep"), "");
		writeFileSync(join(dir, "ABCDEFABCDEF.md"), "upper case");
		writeFileSync(join(dir, "aaaaaaaaaaaa.md.bak"), "backup");
		mkdirSync(join(dir, "bbbbbbbbbbbb.md"));
		writeFileSync(join(root, "outside.md"), "outside");
		symlinkSync(join(root, "outside.md"), join(dir, "cccccccccccc.md"));

		expect(listMemoryFileIds(dir)).toEqual([OBS_ID]);
		expect(removeMemoryFiles(dir, [OBS_ID, "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "../outside"])).toEqual([OBS_ID]);
		expect(existsSync(join(dir, `${OBS_ID}.md`))).toBe(false);
		expect(existsSync(join(dir, "bbbbbbbbbbbb.md"))).toBe(true);
		expect(readFileSync(join(dir, "cccccccccccc.md"), "utf8")).toBe("outside");
		expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("outside");
		expect(existsSync(join(dir, "README.md"))).toBe(true);
	});
});

describe("memory reachability", () => {
	it("follows replaces chains and supporting observations through new records, the ledger and .memory", () => {
		const dir = join(tempDir(), ".memory");
		writeNewMemoryFiles(dir, [
			{ kind: "reflection", id: "111111111111", content: "Old", replaces: ["000000000000"], supportingObservationIds: ["aaaaaaaaaaaa"] },
			{ kind: "reflection", id: "000000000000", content: "Older", supportingObservationIds: ["bbbbbbbbbbbb"] },
			{ kind: "reflection", id: "555555555555", content: "Kept", supportingObservationIds: ["eeeeeeeeeeee"] },
		]);
		const ledger = reflection("333333333333", ["cccccccccccc"]);
		const obsD = observation("dddddddddddd");
		const closure = memoryClosure(
			[{ kind: "reflection", id: "222222222222", content: "New", replaces: ["111111111111", "333333333333"], supportingObservationIds: ["dddddddddddd"], promotedAt: "t" }],
			{ reflectionsById: new Map([[ledger.id, ledger]]), observationsById: new Map([[obsD.id, obsD]]), memoryDir: dir },
			["555555555555"],
		);
		const reachable = closure.reachableIds;

		expect(Array.from(reachable).sort()).toEqual([
			"000000000000", "111111111111", "222222222222", "333333333333", "555555555555",
			"aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "eeeeeeeeeeee",
		]);
	});
});

describe("memory closure", () => {
	it("walks kept ids for reachability only", () => {
		const dir = join(tempDir(), ".memory");
		writeNewMemoryFiles(dir, [
			{ kind: "reflection", id: "555555555555", content: "Kept", replaces: ["444444444444"], supportingObservationIds: ["eeeeeeeeeeee"] },
		]);
		const replaced = reflection("444444444444", ["ffffffffffff"]);
		const obsA = observation("aaaaaaaaaaaa");
		const obsF = observation("ffffffffffff");
		const sources = {
			reflectionsById: new Map([[replaced.id, replaced]]),
			observationsById: new Map([[obsA.id, obsA], [obsF.id, obsF]]),
			memoryDir: dir,
		};
		const promoted: MemoryRecord[] = [{ kind: "reflection", id: "222222222222", content: "New", supportingObservationIds: ["aaaaaaaaaaaa"], promotedAt: "t" }];
		const without = memoryClosure(promoted, sources);
		const withKept = memoryClosure(promoted, sources, ["555555555555", "666666666666"]);

		expect(withKept.records).toEqual(without.records);
		expect(withKept.existingIds).toEqual(without.existingIds);
		expect(withKept.missingIds).toEqual(without.missingIds);
		expect(Array.from(without.reachableIds).sort()).toEqual(["222222222222", "aaaaaaaaaaaa"]);
		expect(Array.from(withKept.reachableIds).sort()).toEqual([
			"222222222222", "444444444444", "555555555555", "666666666666", "aaaaaaaaaaaa", "eeeeeeeeeeee", "ffffffffffff",
		]);
	});

	it("follows replaces chains and supporting observations, including retired and dropped records", () => {
		const dir = join(tempDir(), ".memory");
		const obsA = observation("aaaaaaaaaaaa");
		const obsB = observation("bbbbbbbbbbbb");
		const old = reflection("111111111111", ["bbbbbbbbbbbb"]);
		const older = reflection("000000000000", ["cccccccccccc"]);
		const promoted = { ...reflection("222222222222", ["aaaaaaaaaaaa"]), replaces: ["111111111111"] };
		const oldWithChain = { ...old, replaces: ["000000000000"] };
		const closure = memoryClosure(
			[{ kind: "reflection", id: promoted.id, content: promoted.content, replaces: promoted.replaces, supportingObservationIds: promoted.supportingObservationIds, promotedAt: "t" }],
			{
				reflectionsById: new Map([[old.id, oldWithChain], [older.id, older]]),
				observationsById: new Map([[obsA.id, obsA], [obsB.id, obsB]]),
				sessionId: SESSION,
				memoryDir: dir,
			},
		);

		expect(closure.records.map((record) => record.id)).toEqual(["222222222222", "111111111111", "aaaaaaaaaaaa", "000000000000", "bbbbbbbbbbbb"]);
		expect(closure.records.find((record) => record.id === "111111111111")).toMatchObject({ session: SESSION, replaces: ["000000000000"] });
		expect(closure.missingIds).toEqual(["cccccccccccc"]);
		expect(closure.existingIds).toEqual([]);
	});

	it("uses records that exist only in .memory and skips files already there", () => {
		const dir = join(tempDir(), ".memory");
		writeNewMemoryFiles(dir, [
			{ kind: "reflection", id: "111111111111", content: "Old", session: SESSION, supportingObservationIds: ["aaaaaaaaaaaa"] },
		]);
		const obsA = observation("aaaaaaaaaaaa");
		const closure = memoryClosure(
			[{ kind: "reflection", id: "222222222222", content: "New", replaces: ["111111111111"], supportingObservationIds: [], promotedAt: "t" }],
			{ reflectionsById: new Map(), observationsById: new Map([[obsA.id, obsA]]), memoryDir: dir },
		);

		expect(closure.records.map((record) => record.id)).toEqual(["222222222222", "aaaaaaaaaaaa"]);
		expect(closure.existingIds).toEqual(["111111111111"]);
	});
});

describe("cross-session sources", () => {
	it("finds a session file in any of the project's session dirs and reads only needed entries", () => {
		const root = tempDir();
		const current = join(root, "--project-a--");
		const other = join(root, "--project-b--");
		mkdirSync(current);
		mkdirSync(other);
		const file = join(other, `2026-09-27T00-00-00-000Z_${SESSION}.jsonl`);
		writeFileSync(file, [
			JSON.stringify({ type: "session", id: SESSION }),
			JSON.stringify({ type: "message", id: "9c1e22f0", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "ffffffff", message: { role: "user", content: "other" } }),
			"{\"type\":\"message\",\"id\":\"4ab7d013\",\"trunc",
		].join("\n"));

		expect(findSessionFile(current, SESSION)).toBe(file);
		expect(findSessionFile(current, "../../etc")).toBeUndefined();
		expect(findSessionFile(current, "0".repeat(36))).toBeUndefined();
		expect(readSessionEntries(file, new Set(["9c1e22f0", "4ab7d013"])).map((entry) => entry.id)).toEqual(["9c1e22f0"]);
		expect(readSessionEntries(file, new Set(["9c1e22f0"]), 20)).toEqual([]);
	});
});

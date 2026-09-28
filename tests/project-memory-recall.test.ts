import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashId } from "../src/ids.js";
import { writeNewMemoryFiles, type MemoryRecord } from "../src/project-memory/store.js";
import { formatRecallRenderedResultForTui, recallObservationTool } from "../src/tools/recall-observation.js";
import { observation, observationsRecordedEntry, rawMessage, reflection, reflectionsRecordedEntry, type TestEntry } from "./fixtures/session.js";

const CURRENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const MISSING = "33333333-3333-3333-3333-333333333333";

let root: string;
let project: string;
let sessionDir: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "om-recall-")));
	project = join(root, "repo", "pkg");
	sessionDir = join(root, "sessions", "--repo--");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(root, "sessions", "--other--"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const obsCurrent: MemoryRecord = { kind: "observation", id: hashId("Seen now"), content: "Seen now", timestamp: "2026-09-27 00:46", relevance: "high", session: CURRENT, sourceEntryIds: ["raw-1"] };
const obsOther: MemoryRecord = { kind: "observation", id: hashId("Seen before"), content: "Seen before", timestamp: "2026-09-20 10:00", relevance: "critical", session: OTHER, sourceEntryIds: ["old-1"] };
const obsMissing: MemoryRecord = { kind: "observation", id: hashId("Seen elsewhere"), content: "Seen elsewhere", timestamp: "2026-09-10 10:00", relevance: "low", session: MISSING, sourceEntryIds: ["gone-1"] };
const older: MemoryRecord = { kind: "reflection", id: hashId("Older fact"), content: "Older fact", session: OTHER, supportingObservationIds: [obsOther.id] };
const promoted: MemoryRecord = {
	kind: "reflection",
	id: hashId("Promoted fact"),
	content: "Promoted fact",
	session: CURRENT,
	replaces: [older.id],
	supportingObservationIds: [obsCurrent.id, obsOther.id, obsMissing.id, "eeeeeeeeeeee"],
	promotedAt: "2026-09-28T16:10:00.000Z",
};

async function recall(id: string, entries: TestEntry[], cwd: string | undefined = project) {
	const ctx = {
		...(cwd ? { cwd } : {}),
		sessionManager: { getBranch: () => entries, getSessionId: () => CURRENT, getSessionDir: () => sessionDir },
	};
	const result = await recallObservationTool.execute("tool-1", { id }, undefined as any, undefined as any, ctx as any);
	return { result, text: (result.content[0] as { text: string }).text };
}

describe("recall from project memory", () => {
	it("leaves not-found results unchanged without a .memory store", async () => {
		const { result, text } = await recall("aaaaaaaaaaaa", []);
		expect(text).toBe("No observation or reflection with id aaaaaaaaaaaa was found on the current branch.");
		expect(result.details).not.toHaveProperty("projectMemory");
		expect((await recall("aaaaaaaaaaaa", [], undefined)).text).toBe(text);
	});

	it("prefers the branch ledger over .memory", async () => {
		writeNewMemoryFiles(join(root, "repo", ".memory"), [{ ...promoted, id: "aaaaaaaaaaaa" }]);
		const entries = [
			rawMessage("raw-1", "evidence"),
			observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection("aaaaaaaaaaaa", ["bbbbbbbbbbbb"], { content: "Branch version" })], coversUpToId: "raw-1" }),
		];
		const { text, result } = await recall("aaaaaaaaaaaa", entries);
		expect(text).toContain("Branch version");
		expect(text).not.toContain("From project memory");
		expect(result.details).not.toHaveProperty("projectMemory");
	});

	it("follows links through the nearest store, reads sources from this branch and other sessions, and notes the rest", async () => {
		writeNewMemoryFiles(join(root, "repo", ".memory"), [promoted, older, obsCurrent, obsOther, obsMissing]);
		writeFileSync(join(root, "sessions", "--other--", `2026-09-20T10-00-00-000Z_${OTHER}.jsonl`), [
			JSON.stringify({ type: "session", id: OTHER }),
			JSON.stringify(rawMessage("old-1", "The old conversation")),
		].join("\n"));
		const entries = [rawMessage("raw-1", "The current conversation")];

		const { text, result } = await recall(promoted.id, entries);

		expect(text.startsWith(`From project memory (${join(root, "repo", ".memory")}/):`)).toBe(true);
		expect(text).toContain(`[${promoted.id}] Promoted fact`);
		expect(text).toContain(`Replaces (retired):\n[${older.id}] Older fact`);
		expect(text).toContain("Seen now");
		expect(text).toContain("Seen before");
		expect(text).toContain("The current conversation");
		expect(text).toContain("The old conversation");
		expect(text).toContain("missing: gone-1");
		expect(text).toContain("Supporting observation eeeeeeeeeeee is unavailable");
		expect(text).toContain(`Sources are in session ${MISSING}, not available on this machine.`);
		expect(result.details).toMatchObject({ projectMemory: { editedIds: [], unavailableSessions: [MISSING] } });
		expect(formatRecallRenderedResultForTui(result as any, false)).toContain("[project memory]");
	});

	it("reads each observation's own sources when several come from the same other session", async () => {
		const first: MemoryRecord = { kind: "observation", id: hashId("First old"), content: "First old", timestamp: "2026-09-20 10:00", relevance: "high", session: OTHER, sourceEntryIds: ["old-1"] };
		const second: MemoryRecord = { kind: "observation", id: hashId("Second old"), content: "Second old", timestamp: "2026-09-20 11:00", relevance: "high", session: OTHER, sourceEntryIds: ["old-2"] };
		const fact: MemoryRecord = { kind: "reflection", id: hashId("Two-source fact"), content: "Two-source fact", session: OTHER, supportingObservationIds: [first.id, second.id], promotedAt: "2026-09-28T16:10:00.000Z" };
		writeNewMemoryFiles(join(root, "repo", ".memory"), [fact, first, second]);
		writeFileSync(join(root, "sessions", "--other--", `2026-09-20T10-00-00-000Z_${OTHER}.jsonl`), [
			JSON.stringify({ type: "session", id: OTHER }),
			JSON.stringify(rawMessage("old-1", "The first old message")),
			JSON.stringify(rawMessage("old-2", "The second old message")),
		].join("\n"));

		const { text } = await recall(fact.id, []);

		expect(text).toContain("The first old message");
		expect(text).toContain("The second old message");
		expect(text).not.toContain("missing: old-2");
	});

	it("notes text edited since promotion and serves observation ids directly", async () => {
		const dir = join(project, ".memory");
		mkdirSync(dir);
		writeFileSync(join(dir, `${obsCurrent.id}.md`), `---\nid: ${obsCurrent.id}\nkind: observation\ntimestamp: t\nrelevance: high\nsession: ${CURRENT}\nsourceEntryIds: [raw-1]\n---\nEdited by hand\n`);

		const { text, result } = await recall(obsCurrent.id, [rawMessage("raw-1", "The current conversation")]);

		expect(text).toContain("From project memory (.memory/):");
		expect(text).toContain("The current conversation");
		expect(text).toContain(`Text edited since promotion: ${obsCurrent.id}.`);
		expect(result.details).toMatchObject({ status: "ok", projectMemory: { memoryDir: ".memory", editedIds: [obsCurrent.id] } });
	});
});

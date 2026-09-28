import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ params: undefined as unknown, runPromoter: undefined as any }));
vi.mock("../src/agents/promoter/agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/agents/promoter/agent.js")>();
	mocks.runPromoter = vi.fn(async (args: any) => {
		if (!mocks.params) return undefined;
		const result = actual.validatePromotedBlock(mocks.params as any, args);
		if ("problems" in result) throw new Error(result.problems.join("; "));
		return result;
	});
	return { ...actual, runPromoter: mocks.runPromoter };
});

import { registerPromoteCommand } from "../src/commands/promote.js";
import { resolveProjectContextFiles } from "../src/hooks/project-context.js";
import { hashId } from "../src/ids.js";
import { PROMOTED_END, PROMOTED_START, renderBlock, renderBlockLine } from "../src/project-memory/block.js";
import { parseMemoryFile } from "../src/project-memory/store.js";
import { Runtime } from "../src/runtime.js";
import { foldLedger } from "../src/session-ledger/index.js";
import {
	fakeSessionContext,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

const SESSION = "01a0bfcf-d4de-739b-b7dd-5feda3a16ab8";
const A = reflection(hashId("Fact A"), ["aaaaaaaaaaaa"], { content: "Fact A" });
const B = reflection(hashId("Fact B"), ["bbbbbbbbbbbb"], { content: "Fact B", replaces: ["999999999999"] });
const OLD = reflection("999999999999", ["cccccccccccc"], { content: "Older B" });
const MERGED = "Fact B, merged with a detail";

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "om-promote-cmd-")));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(root, "AGENTS.md"), "# Project\n\nHand-written rules.\n");
	mocks.params = { lines: [{ content: "Fact A", fromIds: [A.id] }, { content: MERGED, fromIds: [B.id] }] };
	mocks.runPromoter.mockClear();
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function ledger() {
	return [
		textCustomMessage("raw-1", "evidence"),
		observationsRecordedEntry("om-obs", {
			observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb"), observation("cccccccccccc")],
			coversUpToId: "raw-1",
		}),
		reflectionsRecordedEntry("om-old", { reflections: [OLD], coversUpToId: "raw-1" }),
		reflectionsDroppedEntry("om-old-drop", { reflectionIds: [OLD.id], replacedBy: B.id, coversUpToId: "raw-1" }),
		reflectionsRecordedEntry("om-ref", { reflections: [A, B], coversUpToId: "raw-1" }),
	];
}

function setup(options: { hasUI?: boolean; confirm?: () => Promise<boolean> | boolean; entries?: any[] } = {}) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const session = fakeSessionContext(options.entries ?? ledger());
	const pi = {
		registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
			handler = command.handler;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => session.appendEntry(customType, data)),
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { contextWindow: 100_000 } }));
	registerPromoteCommand(pi as any, runtime);
	const ctx = {
		cwd: root,
		hasUI: options.hasUI ?? true,
		ui: { notify: vi.fn(), confirm: vi.fn(async () => (options.confirm ? options.confirm() : true)) },
		model: {},
		modelRegistry: {},
		sessionManager: { ...session.sessionManager, getSessionId: () => SESSION },
	};
	return { runtime, ctx, session, pi, run: () => handler!(undefined, ctx) };
}

const agentsPath = () => join(root, "AGENTS.md");
const memoryFiles = () => {
	try {
		return readdirSync(join(root, ".memory")).sort();
	} catch {
		return [];
	}
};

describe("/om:promote", () => {
	it("shows a preview and writes nothing without an interactive session", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const { run, session } = setup({ hasUI: false });
			await run();

			const output = log.mock.calls.map((call) => String(call[0])).join("\n");
			expect(output).toContain("/om:promote preview");
			expect(output).toContain(`+ ${renderBlockLine(A.id, "Fact A")}`);
			expect(output).toContain("needs an interactive session");
			expect(readFileSync(agentsPath(), "utf8")).toBe("# Project\n\nHand-written rules.\n");
			expect(memoryFiles()).toEqual([]);
			expect(session.appended).toEqual([]);
		} finally {
			log.mockRestore();
		}
	});

	it("writes .memory files, the block and the ledger after confirmation", async () => {
		const { run, ctx, session, runtime } = setup();
		await run();

		const mergedId = hashId(MERGED);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/om:promote preview"), "info");
		expect(ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("AGENTS.md: +2 / =0 / -0 lines"));
		const expectedLines = [renderBlockLine(A.id, "Fact A"), renderBlockLine(mergedId, MERGED)];
		expect(readFileSync(agentsPath(), "utf8")).toBe(`# Project\n\nHand-written rules.\n\n${renderBlock(expectedLines)}\n`);

		// Promoted reflections, what they replace (transitively), and every supporting observation.
		expect(memoryFiles()).toEqual([A.id, mergedId, B.id, OLD.id, "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"].map((id) => `${id}.md`).sort());
		const merged = parseMemoryFile(readFileSync(join(root, ".memory", `${mergedId}.md`), "utf8"));
		expect(merged).toMatchObject({ kind: "reflection", session: SESSION, replaces: [B.id], supportingObservationIds: ["bbbbbbbbbbbb"], bodyMatchesId: true });
		expect(merged).toHaveProperty("promotedAt");
		expect(parseMemoryFile(readFileSync(join(root, ".memory", `${B.id}.md`), "utf8"))).not.toHaveProperty("promotedAt");

		expect(session.appended).toEqual([
			{
				customType: "om.reflections.recorded",
				data: { reflections: [{ id: mergedId, content: MERGED, supportingObservationIds: ["bbbbbbbbbbbb"], tokenCount: Math.ceil(MERGED.length / 4), replaces: [B.id] }], coversUpToId: "raw-1" },
			},
			{ customType: "om.reflections.dropped", data: { reflectionIds: [B.id], replacedBy: mergedId, coversUpToId: "raw-1" } },
			{ customType: "om.reflections.dropped", data: { reflectionIds: [A.id, mergedId], kind: "promoted", coversUpToId: "raw-1" } },
		]);
		const folded = foldLedger(session.sessionManager.getBranch() as any);
		expect(folded.activeReflections).toEqual([]);
		expect(folded.reflectionRetirementKind.get(A.id)).toBe("promoted");
		expect(folded.knownReflectionIds.has(A.id)).toBe(false);

		// The reflector sees OM's content for the file until Pi reloads it.
		expect(runtime.contextFileOverrides.get(agentsPath())).toContain(renderBlockLine(A.id, "Fact A"));
		runtime.projectContext = { files: [{ path: agentsPath(), content: "stale" }], source: "snapshot" };
		expect(resolveProjectContextFiles(runtime, root).files[0].content).toContain(PROMOTED_START);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("after /reload or in a new session"), "info");
	});

	it("writes nothing when the user cancels", async () => {
		const { run, session, ctx } = setup({ confirm: () => false });
		await run();

		expect(readFileSync(agentsPath(), "utf8")).toBe("# Project\n\nHand-written rules.\n");
		expect(memoryFiles()).toEqual([]);
		expect(session.appended).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("cancelled"), "info");
	});

	it("aborts without writing when the context file changed since the preview", async () => {
		const { run, session, ctx } = setup({
			confirm: () => {
				writeFileSync(agentsPath(), "# Edited meanwhile\n");
				return true;
			},
		});
		await run();

		expect(readFileSync(agentsPath(), "utf8")).toBe("# Edited meanwhile\n");
		expect(memoryFiles()).toEqual([]);
		expect(session.appended).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("changed on disk since the preview"), "warning");
	});

	it("aborts without writing when a source reflection was retired meanwhile", async () => {
		let session: ReturnType<typeof setup>["session"];
		const setupResult = setup({
			confirm: () => {
				session.appendEntry("om.reflections.dropped", { reflectionIds: [A.id], kind: "stale", coversUpToId: "raw-1" });
				return true;
			},
		});
		session = setupResult.session;
		await setupResult.run();

		expect(memoryFiles()).toEqual([]);
		expect(session.appended).toHaveLength(1);
		expect(setupResult.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`${A.id} no longer active`), "warning");
	});

	it("refuses while a compaction runs, and waits for running memory workers", async () => {
		const busy = setup();
		busy.runtime.compactInFlight = true;
		await busy.run();
		expect(mocks.runPromoter).not.toHaveBeenCalled();
		expect(busy.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");

		const waiting = setup();
		let finish!: () => void;
		waiting.runtime.consolidationPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const done = waiting.run();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(mocks.runPromoter).not.toHaveBeenCalled();
		waiting.runtime.consolidationPromise = null;
		finish();
		await done;
		expect(mocks.runPromoter).toHaveBeenCalledTimes(1);
		expect(waiting.runtime.consolidationInFlight).toBe(false);
		expect(waiting.runtime.promoteInFlight).toBe(false);
	});

	it("reports nothing to promote without reflections or block lines, and refuses broken markers", async () => {
		const empty = setup({ entries: [textCustomMessage("raw-1", "x")] });
		await empty.run();
		expect(mocks.runPromoter).not.toHaveBeenCalled();
		expect(empty.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("no active reflections"), "info");

		writeFileSync(agentsPath(), `${PROMOTED_START}\n- x\n`);
		const broken = setup();
		await broken.run();
		expect(mocks.runPromoter).not.toHaveBeenCalled();
		expect(broken.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("unbalanced"), "error");
	});

	it("keeps and removes existing block lines, reading records only in .memory for rewrites", async () => {
		const first = setup();
		await first.run();
		// A later session: the branch no longer holds the promoted records.
		mocks.params = { lines: [{ content: "Fact A, reworded", fromIds: [A.id] }] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x"), observationsRecordedEntry("om-obs-2", { observations: [observation("dddddddddddd")], coversUpToId: "raw-2" })] });
		await later.run();

		const reworded = hashId("Fact A, reworded");
		const content = readFileSync(agentsPath(), "utf8");
		expect(content).toContain(renderBlockLine(reworded, "Fact A, reworded"));
		expect(content).not.toContain(renderBlockLine(A.id, "Fact A"));
		expect(content.match(new RegExp(PROMOTED_END, "g"))).toHaveLength(1);
		expect(parseMemoryFile(readFileSync(join(root, ".memory", `${reworded}.md`), "utf8"))).toMatchObject({ replaces: [A.id], supportingObservationIds: ["aaaaaaaaaaaa"] });
		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+1 / =0 / -2 lines"));
		expect(later.session.appended).toEqual([
			{ customType: "om.reflections.recorded", data: expect.objectContaining({ coversUpToId: "raw-2" }) },
			{ customType: "om.reflections.dropped", data: { reflectionIds: [reworded], kind: "promoted", coversUpToId: "raw-2" } },
		]);
	});

	it("targets the main worktree from a linked worktree and says so in the preview", async () => {
		const gitdir = join(root, ".git", "worktrees", "feature");
		mkdirSync(gitdir, { recursive: true });
		writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(gitdir, "commondir"), "../..\n");
		const linked = join(root, "wt", "feature");
		mkdirSync(linked, { recursive: true });
		writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);
		const { run, ctx } = setup();
		ctx.cwd = linked;
		await run();

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`linked git worktree (${linked}); the block and .memory/ go to the main worktree at ${root}`), "info");
		expect(readFileSync(agentsPath(), "utf8")).toContain(PROMOTED_START);
		expect(readdirSync(linked)).toEqual([".git"]);
	});
});

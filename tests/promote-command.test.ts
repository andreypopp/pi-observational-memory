import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ params: undefined as unknown, runPromoter: undefined as any, onRun: undefined as (() => void) | undefined }));
vi.mock("../src/agents/promoter/agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/agents/promoter/agent.js")>();
	mocks.runPromoter = vi.fn(async (args: any) => {
		mocks.onRun?.();
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
import { renderPromotedLine, renderPromotedMemory } from "../src/project-memory/memory-file.js";
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
	mocks.onRun = undefined;
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
	const events: string[] = [];
	const loaders: { stop: () => void; stopped: boolean }[] = [];
	const setWidget = vi.fn((key: string, content: unknown) => {
		if (content === undefined) return void events.push(`hide ${key}`);
		const component = typeof content === "function"
			? content({ requestRender() {} }, { fg: (_color: string, text: string) => text })
			: undefined;
		if (component && typeof component.stop === "function") {
			const loader = { stop: component.stop.bind(component), stopped: false };
			component.stop = () => {
				loader.stopped = true;
				loader.stop();
			};
			loaders.push(loader);
		}
		const lines: string[] = Array.isArray(content) ? content : component.render(200);
		events.push(`show ${key}: ${lines.join("").trim()}`);
	});
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
		ui: {
			notify: vi.fn(),
			setWidget,
			confirm: vi.fn(async () => {
				events.push("confirm");
				return options.confirm ? options.confirm() : true;
			}),
		},
		model: {},
		modelRegistry: {},
		sessionManager: { ...session.sessionManager, getSessionId: () => SESSION },
	};
	mocks.onRun = () => events.push("model call");
	return { runtime, ctx, session, pi, events, loaders, run: () => handler!(undefined, ctx) };
}

const agentsPath = () => join(root, "AGENTS.md");
const memoryPath = () => join(root, ".memory.md");
const agentsUntouched = () => expect(readFileSync(agentsPath(), "utf8")).toBe("# Project\n\nHand-written rules.\n");
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
			expect(output).toContain(`+ ${renderPromotedLine(A.id, "Fact A")}`);
			expect(output).toContain("needs an interactive session");
			expect(existsSync(memoryPath())).toBe(false);
			agentsUntouched();
			expect(memoryFiles()).toEqual([]);
			expect(session.appended).toEqual([]);
		} finally {
			log.mockRestore();
		}
	});

	it("writes .memory files, .memory.md and the ledger after confirmation, leaving AGENTS.md alone", async () => {
		const { run, ctx, session, runtime } = setup();
		await run();

		const mergedId = hashId(MERGED);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/om:promote preview"), "info");
		expect(ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining(".memory.md: +2 / =0 / -0 lines"));
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Target: .memory.md (new file)"), "info");
		const expectedLines = [renderPromotedLine(A.id, "Fact A"), renderPromotedLine(mergedId, MERGED)];
		expect(readFileSync(memoryPath(), "utf8")).toBe(renderPromotedMemory(expectedLines));
		agentsUntouched();

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

		// The reflector reads .memory.md fresh, after the snapshot's files.
		runtime.projectContext = { files: [{ path: agentsPath(), content: "rules" }], source: "snapshot" };
		expect(resolveProjectContextFiles(runtime, root).files).toEqual([
			{ path: agentsPath(), content: "rules" },
			{ path: memoryPath(), content: renderPromotedMemory(expectedLines).trimEnd() },
		]);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("sees them from its next prompt"), "info");
		expect(ctx.ui.notify).not.toHaveBeenLastCalledWith(expect.stringContaining("/reload"), "info");
	});

	it("writes nothing when the user cancels", async () => {
		const { run, session, ctx } = setup({ confirm: () => false });
		await run();

		expect(existsSync(memoryPath())).toBe(false);
		expect(memoryFiles()).toEqual([]);
		expect(session.appended).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("cancelled"), "info");
	});

	it("aborts without writing when .memory.md changed since the preview", async () => {
		const { run, session, ctx } = setup({
			confirm: () => {
				writeFileSync(memoryPath(), "- Edited meanwhile\n");
				return true;
			},
		});
		await run();

		expect(readFileSync(memoryPath(), "utf8")).toBe("- Edited meanwhile\n");
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

	it("reports nothing to promote without reflections or promoted lines", async () => {
		const empty = setup({ entries: [textCustomMessage("raw-1", "x")] });
		await empty.run();
		expect(mocks.runPromoter).not.toHaveBeenCalled();
		expect(empty.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("no active reflections"), "info");
	});

	it("shows hand-written text it drops, keeps id-less `- ` lines, and gives the promoter the other context files", async () => {
		writeFileSync(memoryPath(), "# Promoted memory\n\nA note by hand.\n- Written without an id\n");
		mocks.params = { lines: [{ keepId: hashId("Written without an id") }, { content: "Fact A", fromIds: [A.id] }] };
		const { run, ctx, runtime } = setup();
		runtime.projectContext = { files: [{ path: agentsPath(), content: "rules" }], source: "snapshot" };
		await run();

		const promoterArgs = mocks.runPromoter.mock.calls[0][0];
		expect(promoterArgs.promotedLines.map((line: any) => line.content)).toEqual(["Written without an id"]);
		expect(promoterArgs.projectContext).toContain("rules");
		expect(promoterArgs.projectContext).not.toContain("Written without an id");
		const preview = String(ctx.ui.notify.mock.calls.find((call: unknown[]) => String(call[0]).includes("preview"))![0]);
		expect(preview).toContain("Other text in the file, not kept (only `- ` lines are):\n  A note by hand.");
		expect(readFileSync(memoryPath(), "utf8")).toBe(renderPromotedMemory(["- Written without an id", renderPromotedLine(A.id, "Fact A")]));
	});

	it("keeps and removes existing block lines, reading records only in .memory for rewrites", async () => {
		const first = setup();
		await first.run();
		// A later session: the branch no longer holds the promoted records.
		mocks.params = { lines: [{ content: "Fact A, reworded", fromIds: [A.id] }] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x"), observationsRecordedEntry("om-obs-2", { observations: [observation("dddddddddddd")], coversUpToId: "raw-2" })] });
		await later.run();

		const reworded = hashId("Fact A, reworded");
		expect(readFileSync(memoryPath(), "utf8")).toBe(renderPromotedMemory([renderPromotedLine(reworded, "Fact A, reworded")]));
		expect(parseMemoryFile(readFileSync(join(root, ".memory", `${reworded}.md`), "utf8"))).toMatchObject({ replaces: [A.id], supportingObservationIds: ["aaaaaaaaaaaa"] });
		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+1 / =0 / -2 lines"));
		// The rewrite replaces A, so A and its evidence stay; the dropped merged line's chain goes.
		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+1 / -5 .memory files"));
		expect(memoryFiles()).toEqual([reworded, A.id, "aaaaaaaaaaaa"].map((id) => `${id}.md`).sort());
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

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`linked git worktree (${linked}); .memory.md and .memory/ go to the main worktree at ${root}`), "info");
		expect(readFileSync(memoryPath(), "utf8")).toContain(renderPromotedLine(A.id, "Fact A"));
		agentsUntouched();
		expect(readdirSync(linked)).toEqual([".git"]);
	});

	it("keeps what kept lines reach through records only in .memory, and removes the rest", async () => {
		const first = setup();
		await first.run();
		const mergedId = hashId(MERGED);
		// A later session: the branch holds none of the promoted records; keep the merged line, drop A.
		mocks.params = { lines: [{ keepId: mergedId }] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x")] });
		await later.run();

		expect(memoryFiles()).toEqual([mergedId, B.id, OLD.id, "bbbbbbbbbbbb", "cccccccccccc"].map((id) => `${id}.md`).sort());
		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+0 / -2 .memory files"));
		const preview = String(later.ctx.ui.notify.mock.calls.find((call: unknown[]) => String(call[0]).includes("preview"))![0]);
		expect(preview).toContain(`.memory/: remove 2 files the block no longer links to: ${[A.id, "aaaaaaaaaaaa"].sort().join(", ")}`);
		expect(later.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("removed 2 .memory file(s)"), "info");
		expect(later.session.appended).toEqual([]);
	});

	it("keeps a hand-edited line's records by its id", async () => {
		await setup().run();
		const mergedId = hashId(MERGED);
		writeFileSync(memoryPath(), readFileSync(memoryPath(), "utf8").replace("] Fact A", "] Fact A, edited by hand"));
		mocks.params = { lines: [{ keepId: A.id }] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x")] });
		await later.run();

		expect(readFileSync(memoryPath(), "utf8")).toContain(`- [${A.id}] Fact A, edited by hand`);
		expect(readFileSync(memoryPath(), "utf8")).not.toContain(mergedId);
		expect(memoryFiles()).toEqual([A.id, "aaaaaaaaaaaa"].map((id) => `${id}.md`).sort());
	});

	it("applies a cleanup-only plan, leaving non-id files, subdirectories and symlinks alone", async () => {
		await setup().run();
		const before = memoryFiles();
		const dir = join(root, ".memory");
		writeFileSync(join(dir, "eeeeeeeeeeee.md"), "stray");
		writeFileSync(join(dir, "README.md"), "readme");
		mkdirSync(join(dir, "ffffffffffff.md"));
		writeFileSync(join(root, "outside.md"), "outside");
		symlinkSync(join(root, "outside.md"), join(dir, "dddddddddddd.md"));
		const content = readFileSync(memoryPath(), "utf8");
		mocks.params = { lines: [{ keepId: A.id }, { keepId: hashId(MERGED) }] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x")] });
		await later.run();

		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+0 / -1 .memory files"));
		expect(readFileSync(memoryPath(), "utf8")).toBe(content);
		expect(memoryFiles()).toEqual([...before, "README.md", "dddddddddddd.md", "ffffffffffff.md"].sort());
		expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("outside");
		expect(later.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("removed 1 .memory file(s)"), "info");
	});

	it("removes every id file and .memory.md when all lines are dropped", async () => {
		await setup().run();
		writeFileSync(join(root, ".memory", "README.md"), "readme");
		mocks.params = { lines: [] };
		const later = setup({ entries: [textCustomMessage("raw-2", "x")] });
		await later.run();

		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+0 / =0 / -2 lines (~"));
		expect(later.ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+0 / -7 .memory files"));
		expect(memoryFiles()).toEqual(["README.md"]);
		expect(existsSync(memoryPath())).toBe(false);
		expect(later.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Target: .memory.md (deleted: no lines remain)"), "info");
		agentsUntouched();
	});

	it("has nothing to remove without a .memory directory", async () => {
		const { run, ctx } = setup();
		await run();
		expect(ctx.ui.confirm).toHaveBeenCalledWith("Promote memory?", expect.stringContaining("+7 / -0 .memory files"));
		const preview = String(ctx.ui.notify.mock.calls.find((call: unknown[]) => String(call[0]).includes("preview"))![0]);
		expect(preview).not.toContain("remove");
	});

	describe("status widget", () => {
		const choosing = "show om-promote: ⠋ Promoting memory: choosing reflections… (2 active)";
		const writing = "show om-promote: ⠋ Promoting memory: writing .memory.md and .memory/…";

		it("spins during the model call and the apply, and is hidden for the confirm dialog", async () => {
			const { run, events, loaders } = setup();
			await run();
			expect(events).toEqual([choosing, "model call", "hide om-promote", "confirm", writing, "hide om-promote"]);
			expect(loaders.map((loader) => loader.stopped)).toEqual([true, true]);
		});

		it("is cleared on cancel, on errors and when nothing changes", async () => {
			const cancelled = setup({ confirm: () => false });
			await cancelled.run();
			expect(cancelled.events).toEqual([choosing, "model call", "hide om-promote", "confirm"]);

			const failing = setup();
			mocks.onRun = () => {
				failing.events.push("model call");
				throw new Error("boom");
			};
			await failing.run();
			expect(failing.events).toEqual([choosing, "model call", "hide om-promote"]);
			expect(failing.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("boom"), "error");

			mocks.params = undefined;
			const nothing = setup();
			await nothing.run();
			expect(nothing.events).toEqual([choosing, "model call", "hide om-promote"]);
			expect(nothing.loaders.every((loader) => loader.stopped)).toBe(true);

			mocks.params = { lines: [{ content: "Fact A", fromIds: [A.id] }] };
			const stale = setup({ confirm: () => (writeFileSync(memoryPath(), "# Edited meanwhile\n"), true) });
			await stale.run();
			expect(stale.events.slice(-3)).toEqual(["confirm", writing, "hide om-promote"]);
		});

		it("is never shown without an interactive session", async () => {
			const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
			try {
				const { run, ctx } = setup({ hasUI: false });
				await run();
				expect(ctx.ui.setWidget).not.toHaveBeenCalled();
			} finally {
				log.mockRestore();
			}
		});
	});
});

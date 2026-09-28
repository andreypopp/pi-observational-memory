import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
	runReflectionReview: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));
vi.mock("../src/agents/reviewer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/reviewer/agent.js")>()),
	runReflectionReview: mockAgents.runReflectionReview,
}));

import { GROUND_STATUS_WIDGET, registerGroundCommand } from "../src/commands/ground.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { hashId } from "../src/ids.js";
import { renderBlockLine, renderPromotedMemory } from "../src/project-memory/memory-file.js";
import { Runtime } from "../src/runtime.js";
import { foldLedger, OM_REFLECTIONS_DROPPED, OM_REFLECTIONS_RECORDED, recallMemorySources } from "../src/session-ledger/index.js";
import {
	fakeSessionContext,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

const A = reflection(hashId("Config lives in foo.json"), ["aaaaaaaaaaaa"], { content: "Config lives in foo.json" });
const P = reflection(hashId("Build with make"), ["bbbbbbbbbbbb"], { content: "Build with make" });
const Q = reflection(hashId("Lint with eslint"), ["bbbbbbbbbbbb"], { content: "Lint with eslint" });
const NEW_P = "Build with just";
const HAND_WRITTEN = "# Project\n\nHand-written rules.\n";

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "om-ground-cmd-")));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(root, "AGENTS.md"), HAND_WRITTEN);
	writeFileSync(join(root, ".memory.md"), renderPromotedMemory([renderBlockLine(P.id, P.content), renderBlockLine(Q.id, Q.content)]));
	for (const mock of Object.values(mockAgents)) {
		mock.mockReset();
		mock.mockResolvedValue(undefined);
	}
	mockAgents.runReflectionReview.mockImplementation(async (args: any) => {
		if (!args.grounding) return undefined;
		args.grounding.onToolCall();
		args.grounding.onToolCall();
		return {
			replacements: [],
			retirements: [{ reflectionIds: [A.id], kind: "stale", reason: "src/config.ts:3 reads bar.json" }],
			grounding: {
				toolCalls: 2,
				blockRevisions: [
					{ id: P.id, action: "rewrite", content: NEW_P, reason: "justfile:1" },
					{ id: Q.id, action: "remove", reason: "no eslint config" },
				],
				staleText: [{ path: join(root, "AGENTS.md"), excerpt: "Hand-written rules.", reason: "none apply" }],
			},
		};
	});
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.useRealTimers();
});

function ledger() {
	return [
		textCustomMessage("raw-1", "evidence"),
		observationsRecordedEntry("om-obs", {
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] }), observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-1"] })],
			coversUpToId: "raw-1",
		}),
		reflectionsRecordedEntry("om-ref", { reflections: [A, P, Q], coversUpToId: "raw-1" }),
		reflectionsDroppedEntry("om-promoted", { reflectionIds: [P.id, Q.id], kind: "promoted", coversUpToId: "raw-1" }),
		textCustomMessage("raw-2", "more"),
	];
}

type CompactMode = "hook" | "nothing-to-compact" | "cancelled";

function setup(options: { hasUI?: boolean; confirm?: () => boolean; idle?: boolean; mode?: CompactMode; cwd?: string; onReview?: () => void } = {}) {
	const events: string[] = [];
	const setWidget = vi.fn((key: string, content: unknown) => {
		if (content === undefined) return void events.push(`hide ${key}`);
		if (Array.isArray(content)) return void events.push(`line ${key}: ${content.join("")}`);
		const component = (content as any)({ requestRender() {} }, { fg: (_color: string, text: string) => text });
		const setMessage = component.setMessage.bind(component);
		component.setMessage = (message: string) => {
			events.push(`spin ${key}: ${message}`);
			setMessage(message);
		};
		events.push(`spin ${key}: ${component.render(200).join("").trim().replace(/^\S+\s+/, "")}`);
	});
	const session = fakeSessionContext(ledger());
	const handlers: Record<string, (event: unknown, ctx: any) => unknown> = {};
	let command: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((_name: string, spec: { handler: typeof command }) => {
			command = spec.handler;
		}),
		on: vi.fn((name: string, cb: (event: unknown, ctx: any) => unknown) => {
			handlers[name] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => session.appendEntry(customType, data)),
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config.showWorkerNotifications = false;
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { contextWindow: 100_000 } }));
	registerGroundCommand(pi as any, runtime);
	registerCompactionHook(pi as any, runtime);
	const controller = new AbortController();
	const signal = controller.signal;
	let done!: Promise<void>;
	const ctx: any = {
		cwd: options.cwd ?? root,
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
		isIdle: () => options.idle ?? true,
		sessionManager: { ...session.sessionManager, getSessionId: () => "session-1" },
		compact: vi.fn((callbacks: any) => {
			done = (async () => {
				const mode = options.mode ?? "hook";
				if (mode === "cancelled") return callbacks.onError(new Error("Compaction cancelled"));
				if (mode === "nothing-to-compact") return callbacks.onError(new Error("Nothing to compact (session too small)"));
				const result = await handlers.session_before_compact!({ preparation: { firstKeptEntryId: "raw-2", tokensBefore: 10 }, branchEntries: session.sessionManager.getBranch(), signal }, ctx);
				callbacks.onComplete(result);
			})();
		}),
	};
	const run = async () => {
		await command!(undefined, ctx);
		if (ctx.compact.mock.calls.length > 0) await done;
		await vi.waitFor(() => expect(runtime.promoteInFlight || runtime.compactInFlight).toBe(false));
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { run, ctx, runtime, session, events, signal, abort: () => controller.abort(), lastReport: () => String(ctx.ui.notify.mock.lastCall?.[0]) };
}

const memory = () => readFileSync(join(root, ".memory.md"), "utf8");
const agents = () => readFileSync(join(root, "AGENTS.md"), "utf8");

describe("/om:ground", () => {
	it("refuses while the agent is running, and while busy", async () => {
		const running = setup({ idle: false });
		await running.run();
		expect(running.ctx.compact).not.toHaveBeenCalled();
		expect(running.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("wait until the agent finishes its turn"), "warning");

		const busy = setup();
		busy.runtime.promoteInFlight = true;
		await busy.run().catch(() => undefined);
		expect(busy.ctx.compact).not.toHaveBeenCalled();
		expect(busy.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
	});

	it("runs the grounding review inside the compaction hook and applies the block to .memory.md after it", async () => {
		const { run, runtime, session, signal, events, lastReport } = setup();
		await run();

		expect(mockAgents.runReflectionReview).toHaveBeenCalledTimes(1);
		const args = mockAgents.runReflectionReview.mock.calls[0][0];
		expect(args.signal).toBe(signal);
		expect(args.maxTurns).toBe(60);
		expect(args.grounding.root).toBe(root);
		expect(args.grounding.tools.map((tool: any) => tool.name)).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(args.grounding.blockLines.map((line: any) => line.id)).toEqual([P.id, Q.id]);
		expect(args.grounding.blockRecords.get(P.id)).toMatchObject({ id: P.id });
		expect(args.projectContext ?? "").not.toContain("Build with make");

		const newId = hashId(NEW_P);
		expect(memory()).toBe(renderPromotedMemory([renderBlockLine(newId, NEW_P)]));
		expect(agents()).toBe(HAND_WRITTEN);
		const dropped = session.appended.filter((entry) => entry.customType === OM_REFLECTIONS_DROPPED).map((entry) => entry.data);
		expect(dropped).toContainEqual({ reflectionIds: [A.id], kind: "stale", reason: "src/config.ts:3 reads bar.json", coversUpToId: "raw-1" });
		expect(dropped).toContainEqual(expect.objectContaining({ reflectionIds: [P.id], replacedBy: newId, reason: "justfile:1" }));
		expect(dropped).toContainEqual(expect.objectContaining({ reflectionIds: [Q.id], kind: "stale", reason: "no eslint config" }));
		expect(session.appended.find((entry) => entry.customType === OM_REFLECTIONS_RECORDED)?.data).toMatchObject({ reflections: [{ id: newId, replaces: [P.id] }] });
		const recalled = recallMemorySources(session.sessionManager.getBranch() as any, Q.id);
		expect(recalled.status === "found" && recalled.reflections[0].retirementReason).toBe("no eslint config");

		const report = lastReport();
		expect(report).toContain("reflection pass complete");
		expect(report).toContain("Grounding: 2 tool calls; 1 reflection retired as stale, 0 rewritten");
		expect(report).toContain("Promoted lines: 1 rewritten, 1 removed (applied to .memory.md)");
		expect(report).not.toContain("/reload");
		expect(report).toContain(`- ${join(root, "AGENTS.md")}: "Hand-written rules." — none apply`);

		// Plain lines under Pi's own spinner inside the hook; a spinner only while writing.
		const labels = events.filter((event) => event !== "confirm").map((event) => event.replace(/ \d+s$/, ""));
		expect(labels).toEqual(expect.arrayContaining([
			`line ${GROUND_STATUS_WIDGET}: Grounding: observing…`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: reflecting…`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: checking 1 reflection and 2 .memory.md lines against the repo… 2 tool calls,`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: folding memory…`,
			`spin ${GROUND_STATUS_WIDGET}: Grounding: writing .memory.md and .memory/…`,
		]));
		// Hidden before the confirm dialog, a spinner while writing, cleared at the end.
		const confirmAt = events.indexOf("confirm");
		expect(events[confirmAt - 1]).toBe(`hide ${GROUND_STATUS_WIDGET}`);
		expect(events.slice(confirmAt + 1)).toEqual([`spin ${GROUND_STATUS_WIDGET}: Grounding: writing .memory.md and .memory/…`, `hide ${GROUND_STATUS_WIDGET}`]);
		expect(runtime.compactInFlight || runtime.promoteInFlight || runtime.reflectRequest).toBeFalsy();
	});

	it("writes nothing to the block when declined, and only previews without UI", async () => {
		const original = memory();
		const declined = setup({ confirm: () => false });
		await declined.run();
		expect(memory()).toBe(original);
		expect(declined.lastReport()).toContain("Promoted lines: 1 rewritten, 1 removed (declined)");
		expect(declined.events.slice(-2)).toEqual([`hide ${GROUND_STATUS_WIDGET}`, "confirm"]);

		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const headless = setup({ hasUI: false });
			await headless.run();
			const output = log.mock.calls.map((call) => String(call[0])).join("\n");
			expect(output).toContain("/om:ground block preview");
			expect(output).toContain(`- [${P.id}] rewrite: justfile:1`);
			expect(output).toContain("nothing was written");
			expect(output).toContain("(preview only)");
			expect(memory()).toBe(original);
			expect(headless.ctx.ui.setWidget).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it("does not apply revisions when the block changed during grounding", async () => {
		mockAgents.runObserver.mockImplementation(async () => {
			writeFileSync(join(root, ".memory.md"), renderPromotedMemory([renderBlockLine(P.id, P.content)]));
			return undefined;
		});
		const { run, lastReport } = setup();
		await run();

		expect(memory()).toContain("Build with make");
		expect(lastReport()).toContain("changed during grounding");
	});

	it("runs the pass with a spinner and no signal when Pi has nothing to compact", async () => {
		const { run, events, lastReport } = setup({ mode: "nothing-to-compact" });
		await run();

		expect(mockAgents.runReflectionReview.mock.calls[0][0].signal).toBeUndefined();
		expect(events[0].startsWith(`spin ${GROUND_STATUS_WIDGET}: Grounding: observing…`)).toBe(true);
		expect(events.some((event) => event.startsWith("line "))).toBe(false);
		expect(lastReport()).toContain("Pi had nothing to compact yet");
		expect(lastReport()).toContain("Promoted lines: 1 rewritten, 1 removed (applied");
		expect(events.at(-1)).toBe(`hide ${GROUND_STATUS_WIDGET}`);
	});

	it("reports a cancelled compaction and applies nothing", async () => {
		const original = memory();
		const { run, runtime, ctx } = setup({ mode: "cancelled" });
		await run();

		expect(memory()).toBe(original);
		expect(runtime.reflectRequest).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/om:ground was cancelled"), "warning");
	});

	it("writes nothing from a review the compaction's Esc aborted", async () => {
		const original = memory();
		const { run, session, ctx, abort } = setup();
		const compact = ctx.compact.getMockImplementation();
		ctx.compact.mockImplementation((callbacks: any) => compact({ ...callbacks, onComplete: () => callbacks.onError(new Error("Compaction cancelled")) }));
		const review = mockAgents.runReflectionReview.getMockImplementation()!;
		mockAgents.runReflectionReview.mockImplementationOnce(async (args: any) => {
			abort();
			return review(args);
		});
		await run();

		expect(mockAgents.runReflectionReview).toHaveBeenCalledTimes(1);
		expect(session.appended.filter((entry) => entry.customType === OM_REFLECTIONS_DROPPED)).toEqual([]);
		expect(memory()).toBe(original);
	});

	it("roots the tools at the main worktree from a linked worktree", async () => {
		const gitdir = join(root, ".git", "worktrees", "feature");
		mkdirSync(gitdir, { recursive: true });
		writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(gitdir, "commondir"), "../..\n");
		const linked = join(root, "wt", "feature");
		mkdirSync(linked, { recursive: true });
		writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);

		const { run } = setup({ cwd: linked });
		await run();

		const args = mockAgents.runReflectionReview.mock.calls[0][0];
		expect(args.grounding.root).toBe(root);
		expect(args.grounding.memoryPath).toBe(join(root, ".memory.md"));
		expect(memory()).toContain(renderBlockLine(hashId(NEW_P), NEW_P));
	});

	it("leaves the active reflections untouched when the review makes no changes", async () => {
		mockAgents.runReflectionReview.mockImplementation(async (args: any) => ({ replacements: [], retirements: [], grounding: { toolCalls: 0, blockRevisions: [], staleText: [] } }));
		const { run, session, lastReport } = setup();
		await run();
		expect(foldLedger(session.sessionManager.getBranch() as any).activeReflections.map((r) => r.id)).toEqual([A.id]);
		expect(lastReport()).toContain("Promoted lines: no changes");
		expect(lastReport()).toContain("Stale hand-written text: none found");
	});
});

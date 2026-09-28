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
import { Runtime } from "../src/runtime.js";
import { foldLedger, OM_REFLECTIONS_DROPPED, recallMemorySources } from "../src/session-ledger/index.js";
import {
	fakeSessionContext,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

const A = reflection(hashId("Config lives in foo.json"), ["aaaaaaaaaaaa"], { content: "Config lives in foo.json" });
const HAND_WRITTEN = "# Project\n\nHand-written rules.\n";

let root: string;
let cwd: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "om-ground-cmd-")));
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(root, "AGENTS.md"), HAND_WRITTEN);
	cwd = join(root, "pkg");
	mkdirSync(cwd);
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
			observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
			coversUpToId: "raw-1",
		}),
		reflectionsRecordedEntry("om-ref", { reflections: [A], coversUpToId: "raw-1" }),
		textCustomMessage("raw-2", "more"),
	];
}

type CompactMode = "hook" | "nothing-to-compact" | "cancelled";

function setup(options: { hasUI?: boolean; idle?: boolean; mode?: CompactMode; projectContext?: boolean } = {}) {
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
	if (options.projectContext === false) runtime.config.projectContext = false;
	// A stale snapshot: the command must refresh it from getSystemPromptOptions.
	runtime.projectContext = { files: [{ path: "/old/AGENTS.md", content: "old rules" }], source: "snapshot" };
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { contextWindow: 100_000 } }));
	registerGroundCommand(pi as any, runtime);
	registerCompactionHook(pi as any, runtime);
	const controller = new AbortController();
	const signal = controller.signal;
	let done!: Promise<void>;
	const ctx: any = {
		cwd,
		hasUI: options.hasUI ?? true,
		ui: { notify: vi.fn(), setWidget },
		model: {},
		modelRegistry: {},
		isIdle: () => options.idle ?? true,
		getSystemPromptOptions: () => ({ contextFiles: [{ path: join(root, "AGENTS.md"), content: readFileSync(join(root, "AGENTS.md"), "utf8") }] }),
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
	const run = async (args?: string) => {
		await command!(args, ctx);
		if (ctx.compact.mock.calls.length > 0) await done;
		await vi.waitFor(() => expect(runtime.compactInFlight).toBe(false));
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { run, ctx, runtime, session, events, signal, abort: () => controller.abort(), lastReport: () => String(ctx.ui.notify.mock.lastCall?.[0]) };
}

const agents = () => readFileSync(join(root, "AGENTS.md"), "utf8");

describe("/om:ground", () => {
	it("refuses while the agent is running, and while a compaction is running", async () => {
		const running = setup({ idle: false });
		await running.run();
		expect(running.ctx.compact).not.toHaveBeenCalled();
		expect(running.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("wait until the agent finishes its turn"), "warning");

		const busy = setup();
		busy.runtime.compactHookInFlight = true;
		await busy.run().catch(() => undefined);
		expect(busy.ctx.compact).not.toHaveBeenCalled();
		expect(busy.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
	});

	it("runs the grounding review inside the compaction hook, rooted at the session's cwd, and reports stale text", async () => {
		const { run, runtime, session, signal, events, ctx, lastReport } = setup();
		await run();

		expect(mockAgents.runReflectionReview).toHaveBeenCalledTimes(1);
		const args = mockAgents.runReflectionReview.mock.calls[0][0];
		expect(args.signal).toBe(signal);
		expect(args.maxTurns).toBe(60);
		expect(args.grounding.root).toBe(cwd);
		expect(Object.keys(args.grounding).sort()).toEqual(["onToolCall", "root", "tools"]);
		expect(args.grounding.tools.map((tool: any) => tool.name)).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(args).not.toHaveProperty("userInstruction");
		expect(mockAgents.runReflector.mock.calls[0][0]).not.toHaveProperty("userInstruction");

		expect(agents()).toBe(HAND_WRITTEN);
		const dropped = session.appended.filter((entry) => entry.customType === OM_REFLECTIONS_DROPPED).map((entry) => entry.data);
		expect(dropped).toEqual([{ reflectionIds: [A.id], kind: "stale", reason: "src/config.ts:3 reads bar.json", coversUpToId: "raw-1" }]);
		const recalled = recallMemorySources(session.sessionManager.getBranch() as any, A.id);
		expect(recalled.status === "found" && recalled.reflections[0].retirementReason).toBe("src/config.ts:3 reads bar.json");

		expect(ctx.ui.notify.mock.calls[0][0]).not.toContain("Instruction:");
		const report = lastReport();
		expect(report).toContain("reflection pass complete");
		expect(report).not.toContain("Instruction:");
		expect(report).toContain("Grounding: 2 tool calls; 1 reflection retired as stale, 0 rewritten");
		expect(report).not.toMatch(/promot/i);
		expect(report).toContain(`- ${join(root, "AGENTS.md")}: "Hand-written rules." — none apply`);

		// Plain lines under Pi's own spinner inside the hook, cleared at the end.
		const labels = events.map((event) => event.replace(/ \d+s$/, ""));
		expect(labels).toEqual(expect.arrayContaining([
			`line ${GROUND_STATUS_WIDGET}: Grounding: observing…`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: reflecting…`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: checking 1 reflection against the repo… 2 tool calls,`,
			`line ${GROUND_STATUS_WIDGET}: Grounding: folding memory…`,
		]));
		expect(events.at(-1)).toBe(`hide ${GROUND_STATUS_WIDGET}`);
		expect(runtime.compactInFlight || runtime.reflectRequest).toBeFalsy();
	});

	it.each<CompactMode>(["hook", "nothing-to-compact"])("hands the refreshed, unfiltered context files to crystallize and the grounding review (%s)", async (mode) => {
		const { run } = setup({ mode });
		await run();

		const crystallize = mockAgents.runReflector.mock.calls[0][0].projectContext as string;
		const review = mockAgents.runReflectionReview.mock.calls[0][0].projectContext as string;
		for (const text of [crystallize, review]) {
			expect(text).toContain(`### ${join(root, "AGENTS.md")}\n${HAND_WRITTEN.trimEnd()}`);
			expect(text).not.toContain("old rules");
		}
	});

	it("gives both reflector calls no project context with projectContext false", async () => {
		const { run } = setup({ projectContext: false });
		await run();

		expect(mockAgents.runReflector.mock.calls[0][0].projectContext).toBe("");
		expect(mockAgents.runReflectionReview.mock.calls[0][0].projectContext).toBe("");
	});

	it("passes the trimmed instruction to crystallize and the grounding review only, and echoes it", async () => {
		const { run, ctx, lastReport } = setup();
		await run("  only check the config facts  ");

		expect(mockAgents.runReflector.mock.calls[0][0].userInstruction).toBe("only check the config facts");
		expect(mockAgents.runReflectionReview.mock.calls[0][0].userInstruction).toBe("only check the config facts");
		for (const call of [...mockAgents.runObserver.mock.calls, ...mockAgents.runDropper.mock.calls]) expect(call[0]).not.toHaveProperty("userInstruction");
		expect(ctx.ui.notify.mock.calls[0][0]).toContain("\nInstruction: only check the config facts");
		expect(lastReport()).toContain("\nInstruction: only check the config facts\n");
	});

	it("treats blank arguments as no instruction", async () => {
		const { run, ctx } = setup();
		await run("   ");

		expect(mockAgents.runReflector.mock.calls[0][0]).not.toHaveProperty("userInstruction");
		expect(mockAgents.runReflectionReview.mock.calls[0][0]).not.toHaveProperty("userInstruction");
		expect(ctx.ui.notify.mock.calls.map((call: any[]) => call[0]).join("\n")).not.toContain("Instruction:");
	});

	it("runs the pass with a spinner and no signal when Pi has nothing to compact", async () => {
		const { run, events, lastReport } = setup({ mode: "nothing-to-compact" });
		await run("tidy up");

		expect(mockAgents.runReflectionReview.mock.calls[0][0].signal).toBeUndefined();
		expect(mockAgents.runReflectionReview.mock.calls[0][0].userInstruction).toBe("tidy up");
		expect(events[0].startsWith(`spin ${GROUND_STATUS_WIDGET}: Grounding: observing…`)).toBe(true);
		expect(events.some((event) => event.startsWith("line "))).toBe(false);
		expect(lastReport()).toContain("Pi had nothing to compact yet");
		expect(lastReport()).toContain("Instruction: tidy up");
		expect(events.at(-1)).toBe(`hide ${GROUND_STATUS_WIDGET}`);
	});

	it("reports a cancelled compaction", async () => {
		const { run, runtime, ctx } = setup({ mode: "cancelled" });
		await run();

		expect(runtime.reflectRequest).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/om:ground was cancelled"), "warning");
	});

	it("writes nothing from a review the compaction's Esc aborted", async () => {
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
	});

	it("leaves the active reflections untouched when the review makes no changes", async () => {
		mockAgents.runReflectionReview.mockImplementation(async () => ({ replacements: [], retirements: [], grounding: { toolCalls: 0, staleText: [] } }));
		const { run, session, lastReport } = setup();
		await run();
		expect(foldLedger(session.sessionManager.getBranch() as any).activeReflections.map((r) => r.id)).toEqual([A.id]);
		expect(lastReport()).toContain("Stale hand-written text: none found");
	});
});

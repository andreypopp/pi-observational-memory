import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../src/agents/reviewer/agent.js", () => ({ runReflectionReview: mockAgents.runReflectionReview }));

import { parseInstruction, registerReflectCommand } from "../src/commands/reflect.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import {
	fakeSessionContext,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

const REF = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "Old reflection" });
const AGENTS = { path: "/repo/AGENTS.md", content: "# Rules\n\nUse vitest." };

beforeEach(() => {
	for (const mock of Object.values(mockAgents)) {
		mock.mockReset();
		mock.mockResolvedValue(undefined);
	}
	// The review retires something so the dropper runs too.
	mockAgents.runReflectionReview.mockResolvedValue({ replacements: [], retirements: [{ reflectionIds: [REF.id], kind: "stale" }] });
});

function setup(options: { mode?: "hook" | "nothing-to-compact"; projectContext?: boolean } = {}) {
	const session = fakeSessionContext([
		textCustomMessage("raw-1", "evidence"),
		observationsRecordedEntry("om-obs", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })], coversUpToId: "raw-1" }),
		reflectionsRecordedEntry("om-ref", { reflections: [REF], coversUpToId: "raw-1" }),
		textCustomMessage("raw-2", "more"),
	]);
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
	runtime.config.observationsPoolMaxTokens = 1;
	runtime.config.observationsPoolTargetTokens = 1;
	if (options.projectContext === false) runtime.config.projectContext = false;
	// A stale snapshot: the command must refresh it from getSystemPromptOptions.
	runtime.projectContext = { files: [{ path: "/old/AGENTS.md", content: "old rules" }], source: "snapshot" };
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { contextWindow: 100_000 } }));
	registerReflectCommand(pi as any, runtime);
	registerCompactionHook(pi as any, runtime);
	let done!: Promise<void>;
	const ctx: any = {
		cwd: "/repo",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: {},
		modelRegistry: {},
		isIdle: () => true,
		getSystemPromptOptions: () => ({ contextFiles: [AGENTS] }),
		sessionManager: { ...session.sessionManager, getSessionId: () => "session-1" },
		compact: vi.fn((callbacks: any) => {
			done = (async () => {
				if (options.mode === "nothing-to-compact") return callbacks.onError(new Error("Nothing to compact (session too small)"));
				const result = await handlers.session_before_compact!({
					preparation: { firstKeptEntryId: "raw-2", tokensBefore: 10 },
					branchEntries: session.sessionManager.getBranch(),
					signal: new AbortController().signal,
				}, ctx);
				callbacks.onComplete(result);
			})();
		}),
	};
	const run = async (args?: string) => {
		await command!(args, ctx);
		await done;
		await vi.waitFor(() => expect(runtime.compactInFlight).toBe(false));
	};
	return { run, ctx, notices: () => ctx.ui.notify.mock.calls.map((call: any[]) => String(call[0])) };
}

describe("parseInstruction", () => {
	it("trims the command's arguments and treats blank ones as none", () => {
		expect(parseInstruction("  merge the auth reflections  ")).toBe("merge the auth reflections");
		expect(parseInstruction("")).toBeUndefined();
		expect(parseInstruction("  \n ")).toBeUndefined();
		expect(parseInstruction(undefined)).toBeUndefined();
	});
});

describe("/om:reflect instruction and project context", () => {
	it.each(["hook", "nothing-to-compact"] as const)("passes the instruction to crystallize and review only, and echoes it (%s)", async (mode) => {
		const { run, notices } = setup({ mode });
		await run("  replace all reflections about auth with one saying: tokens live in the keychain ");

		const instruction = "replace all reflections about auth with one saying: tokens live in the keychain";
		expect(mockAgents.runReflector.mock.calls[0][0].userInstruction).toBe(instruction);
		expect(mockAgents.runReflectionReview.mock.calls[0][0].userInstruction).toBe(instruction);
		expect(mockAgents.runObserver).toHaveBeenCalled();
		expect(mockAgents.runDropper).toHaveBeenCalled();
		for (const call of [...mockAgents.runObserver.mock.calls, ...mockAgents.runDropper.mock.calls]) expect(call[0]).not.toHaveProperty("userInstruction");
		expect(notices()[0]).toBe(`Observational memory: reflecting — running memory workers, then compacting\nInstruction: ${instruction}`);
		expect(notices().at(-1)).toMatch(new RegExp(`^Observational memory: reflection pass complete\nInstruction: ${instruction}\n`));
	});

	it("leaves the worker inputs and messages unchanged without an instruction", async () => {
		const { run, notices } = setup();
		await run("   ");

		expect(mockAgents.runReflector.mock.calls[0][0]).not.toHaveProperty("userInstruction");
		expect(mockAgents.runReflectionReview.mock.calls[0][0]).not.toHaveProperty("userInstruction");
		expect(notices()[0]).toBe("Observational memory: reflecting — running memory workers, then compacting");
		expect(notices().join("\n")).not.toContain("Instruction:");
	});

	it.each(["hook", "nothing-to-compact"] as const)("hands the refreshed context files to crystallize and review (%s)", async (mode) => {
		const { run } = setup({ mode });
		await run();

		for (const call of [mockAgents.runReflector.mock.calls[0][0], mockAgents.runReflectionReview.mock.calls[0][0]]) {
			expect(call.projectContext).toContain(`### ${AGENTS.path}\n${AGENTS.content}`);
			expect(call.projectContext).not.toContain("old rules");
		}
		for (const call of [...mockAgents.runObserver.mock.calls, ...mockAgents.runDropper.mock.calls]) expect(call[0]).not.toHaveProperty("projectContext");
	});

	it("gives no project context with projectContext false", async () => {
		const { run } = setup({ projectContext: false });
		await run();

		expect(mockAgents.runReflector.mock.calls[0][0].projectContext).toBe("");
		expect(mockAgents.runReflectionReview.mock.calls[0][0].projectContext).toBe("");
	});
});

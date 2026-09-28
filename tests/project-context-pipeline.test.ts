import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
	runReflectionReview: vi.fn(),
	loadProjectContextFiles: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => "/agent-dir",
	loadProjectContextFiles: mocks.loadProjectContextFiles,
}));
vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mocks.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mocks.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mocks.runDropper }));
vi.mock("../src/agents/reviewer/agent.js", () => ({ runReflectionReview: mocks.runReflectionReview }));

import { DEFAULTS } from "../src/config.js";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.js";
import { captureProjectContextFiles } from "../src/hooks/project-context.js";
import { Runtime } from "../src/runtime.js";
import { OM_REFLECTIONS_DROPPED, OM_REFLECTIONS_RECORDED, foldLedger } from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

const SNAPSHOT_FILE = { path: "/repo/AGENTS.md", content: "Always run npm test." };
const LOADER_FILE = { path: "/repo/CLAUDE.md", content: "Loaded from disk." };
const HEADER = "PROJECT INSTRUCTIONS (loaded into every session of this project; reference only):";

const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 50 });
const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-1"], tokenCount: 50 });
const kept = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
const coveredByInstructions = reflection("cccccccccccc", ["aaaaaaaaaaaa"]);
const stale = reflection("dddddddddddd", ["aaaaaaaaaaaa"]);
const crystallized = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);

function setup(extraEntries: TestEntry[] = [], config: Partial<Runtime["config"]> = {}) {
	let entries: TestEntry[] = [
		textCustomMessage("raw-1", "a".repeat(400)),
		observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
		reflectionsRecordedEntry("om-ref", { reflections: [kept, coveredByInstructions, stale], coversUpToId: "raw-1" }),
		...extraEntries,
		textCustomMessage("raw-2", "b".repeat(400)),
	];
	const pi = {
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, { type: "custom", id: `appended-${pi.appendEntry.mock.calls.length}`, parentId: null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
		}),
	};
	const runtime = new Runtime();
	runtime.config = {
		...DEFAULTS,
		observeAfterTokens: 1,
		reflectAfterTokens: 1,
		observationsPoolMaxTokens: 60,
		observationsPoolTargetTokens: 30,
		showWorkerNotifications: false,
		...config,
	};
	runtime.configLoaded = true;
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { provider: "p", id: "m", contextWindow: 1_000_000 }, apiKey: "key" }));
	const ctx = {
		cwd: "/repo",
		hasUI: false,
		model: { provider: "p", id: "m" },
		modelRegistry: {},
		sessionManager: { getBranch: () => entries },
	};
	return { pi, runtime, ctx, run: () => runConsolidationPipeline(pi as any, runtime, ctx as any), getEntries: () => entries };
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.runObserver.mockResolvedValue(undefined);
	mocks.runReflector.mockResolvedValue([crystallized]);
	mocks.runReflectionReview.mockResolvedValue(undefined);
	mocks.runDropper.mockResolvedValue(undefined);
	mocks.loadProjectContextFiles.mockReturnValue([LOADER_FILE]);
});

describe("project context in the consolidation pipeline", () => {
	it("gives the snapshot to both reflector calls, and nothing to the observer or dropper", async () => {
		const { run, runtime } = setup();
		captureProjectContextFiles(runtime, [SNAPSHOT_FILE], "snapshot");

		await run();

		const crystallizeContext = mocks.runReflector.mock.calls[0][0].projectContext;
		const reviewContext = mocks.runReflectionReview.mock.calls[0][0].projectContext;
		expect(crystallizeContext).toBe(`${HEADER}\n\n### ${SNAPSHOT_FILE.path}\n${SNAPSHOT_FILE.content}`);
		expect(reviewContext).toBe(crystallizeContext);
		expect(mocks.runObserver).toHaveBeenCalled();
		expect(mocks.runObserver.mock.calls[0][0]).not.toHaveProperty("projectContext");
		expect(mocks.runDropper).toHaveBeenCalled();
		expect(mocks.runDropper.mock.calls[0][0]).not.toHaveProperty("projectContext");
		expect(mocks.loadProjectContextFiles).not.toHaveBeenCalled();
	});

	it("loads the files itself when no before_agent_start snapshot exists (fresh Runtime, triggerTurn runs)", async () => {
		const { run } = setup();

		await run();

		expect(mocks.loadProjectContextFiles).toHaveBeenCalledWith({ cwd: "/repo", agentDir: "/agent-dir" });
		expect(mocks.runReflector.mock.calls[0][0].projectContext).toContain(`### ${LOADER_FILE.path}\n${LOADER_FILE.content}`);
		expect(mocks.runReflectionReview.mock.calls[0][0].projectContext).toContain(`### ${LOADER_FILE.path}`);
	});

	it("passes an empty project context when there are no files or the feature is off", async () => {
		mocks.loadProjectContextFiles.mockReturnValue([]);
		const empty = setup();
		await empty.run();
		expect(mocks.runReflector.mock.calls[0][0].projectContext).toBe("");
		expect(mocks.runReflectionReview.mock.calls[0][0].projectContext).toBe("");

		mocks.runReflector.mockClear();
		mocks.runReflectionReview.mockClear();
		const off = setup([], { projectContext: false });
		captureProjectContextFiles(off.runtime, [SNAPSHOT_FILE], "snapshot");
		await off.run();
		expect(mocks.runReflector.mock.calls[0][0].projectContext).toBe("");
		expect(mocks.runReflectionReview.mock.calls[0][0].projectContext).toBe("");
	});

	it("caps the rendered files with projectContextMaxTokens", async () => {
		const { run, runtime } = setup([], { projectContextMaxTokens: 5 });
		captureProjectContextFiles(runtime, [SNAPSHOT_FILE], "snapshot");

		await run();

		expect(mocks.runReflector.mock.calls[0][0].projectContext).toBe(`${HEADER}\n\n(omitted: ${SNAPSHOT_FILE.path}, ~10 tokens)`);
	});

	it("lets crystallize re-record ids retired as covered by project instructions, but not other retired ids", async () => {
		const { run } = setup([
			reflectionsDroppedEntry("om-ret-pi", { reflectionIds: [coveredByInstructions.id], kind: "project-instructions", coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ret-stale", { reflectionIds: [stale.id], kind: "stale", coversUpToId: "raw-1" }),
		]);

		await run();

		const known: ReadonlySet<string> = mocks.runReflector.mock.calls[0][0].knownReflectionIds;
		expect(known.has(coveredByInstructions.id)).toBe(false);
		expect(known.has(stale.id)).toBe(true);
		expect(known.has(kept.id)).toBe(true);
	});

	it("re-activates a project-instructions retirement when crystallize records the same id again", async () => {
		mocks.runReflector.mockResolvedValue([coveredByInstructions]);
		const { run, getEntries } = setup([
			reflectionsDroppedEntry("om-ret-pi", { reflectionIds: [coveredByInstructions.id], kind: "project-instructions", coversUpToId: "raw-1" }),
		]);

		await run();

		const folded = foldLedger(getEntries() as any);
		expect(folded.activeReflections.map((r) => r.id)).toContain(coveredByInstructions.id);
		expect(mocks.runReflectionReview.mock.calls[0][0].reflections.map((r: { id: string }) => r.id)).toContain(coveredByInstructions.id);
	});

	it("writes the review's retirement kind into om.reflections.dropped", async () => {
		mocks.runReflectionReview.mockResolvedValue({
			replacements: [],
			retirements: [
				{ reflectionIds: [coveredByInstructions.id], kind: "project-instructions" },
				{ reflectionIds: [stale.id] },
			],
		});
		const { run, pi } = setup();

		await run();

		const dropped = pi.appendEntry.mock.calls.filter(([type]) => type === OM_REFLECTIONS_DROPPED).map(([, data]) => data);
		expect(dropped).toEqual([
			{ reflectionIds: [coveredByInstructions.id], kind: "project-instructions", coversUpToId: "raw-1" },
			{ reflectionIds: [stale.id], coversUpToId: "raw-1" },
		]);
		expect(pi.appendEntry.mock.calls.some(([type]) => type === OM_REFLECTIONS_RECORDED)).toBe(true);
	});
});

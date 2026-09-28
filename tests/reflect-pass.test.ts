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

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { emptyReflectReport, type ReflectRequest } from "../src/reflect-report.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	for (const mock of Object.values(mockAgents)) {
		mock.mockReset();
		mock.mockResolvedValue(undefined);
	}
});

function setup(args: { entries: TestEntry[]; observationsPoolMaxTokens?: number; observationsPoolTargetTokens?: number }) {
	let entries = [...args.entries];
	const handlers: Record<string, (event: unknown, ctx: any) => unknown> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => unknown) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return id;
		}),
	};
	const runtime = {
		config: {
			showWorkerNotifications: false,
			passive: false,
			debugLog: false,
			observeAfterTokens: 1_000_000,
			reflectAfterTokens: 1_000_000,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 1_000_000,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? 1_000_000,
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
		},
		consolidationInFlight: false,
		consolidationPromise: null as Promise<void> | null,
		consolidationPhase: undefined as string | undefined,
		compactInFlight: false,
		compactHookInFlight: false,
		reflectRequest: undefined as ReflectRequest | undefined,
		resolveFailureNotified: false,
		reflectorModelFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastReviewError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key" })),
		resolveFallbackModel: vi.fn(async () => ({ ok: false, reason: "no fallback model configured" })),
		resolveReflectorModel: vi.fn(async () => ({ ok: false, reason: "no reflector model configured" })),
		launchConsolidationTask: vi.fn(async (_ctx: unknown, work: () => Promise<void>) => {
			runtime.consolidationInFlight = true;
			try {
				await work();
			} finally {
				runtime.consolidationInFlight = false;
			}
		}),
		recordConsolidationStageError: vi.fn((_ctx: unknown, phase: string, error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (phase === "observer") runtime.lastObserverError = message;
			if (phase === "reflector") runtime.lastReflectorError = message;
			if (phase === "review") runtime.lastReviewError = message;
			if (phase === "dropper") runtime.lastDropperError = message;
			return message;
		}),
	};
	registerCompactionHook(pi as any, runtime as any);
	registerConsolidationTrigger(pi as any, runtime as any);
	const ctx = {
		cwd: "/tmp/project",
		hasUI: false,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
	};
	const signal = new AbortController().signal;
	const compact = (firstKeptEntryId: string) => handlers.session_before_compact!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: [...entries],
		signal,
	}, ctx) as Promise<any>;
	const requestReflect = () => {
		const request: ReflectRequest = { report: emptyReflectReport() };
		runtime.reflectRequest = request;
		return request;
	};
	return { pi, runtime, ctx, signal, compact, requestReflect, turnEnd: () => handlers.turn_end!(undefined, ctx), getEntries: () => entries };
}

const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 5 });
const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 5 });
const oldRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "Old reflection" });
const newRef = reflection("111111111111", ["aaaaaaaaaaaa"], { content: "New reflection" });

describe("/om:reflect forced pass in the compaction hook", () => {
	it("consumes the request once and leaves later compactions untouched", async () => {
		const { compact, requestReflect, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")] });
		const request = requestReflect();

		await compact("raw-2");
		expect(runtime.reflectRequest).toBeUndefined();
		expect(request.report.started).toBe(true);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		await compact("raw-2");
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
	});

	it("runs every stage below thresholds, limits the observer to the cut, and caps written coverage", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		mockAgents.runReflectionReview.mockResolvedValueOnce({ replacements: [], retirements: [{ reflectionIds: ["eeeeeeeeeeee"] }] });
		mockAgents.runDropper.mockResolvedValueOnce(["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-0", "zzzz"),
			observationsRecordedEntry("om-obs", { observations: [obsB], coversUpToId: "raw-0" }),
			reflectionsRecordedEntry("om-ref", { reflections: [oldRef], coversUpToId: "raw-0" }),
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			textCustomMessage("raw-3", "cccc"),
		];
		const { compact, requestReflect, pi, signal } = setup({ entries, observationsPoolTargetTokens: 1 });
		const request = requestReflect();

		const result = await compact("raw-2");

		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({ allowedSourceEntryIds: ["raw-1", "raw-2"], signal }));
		expect(mockAgents.runReflector).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(mockAgents.runReflectionReview).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(mockAgents.runDropper).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(pi.appendEntry.mock.calls).toEqual([
			[OM_OBSERVATIONS_RECORDED, { observations: [obsA], coversUpToId: "raw-2" }],
			[OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" }],
			[OM_REFLECTIONS_DROPPED, { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-2" }],
			[OM_OBSERVATIONS_DROPPED, { observationIds: ["bbbbbbbbbbbb"], coversUpToId: "raw-2" }],
		]);
		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.reflections).toEqual([newRef]);
		expect(result.compaction.details.observations).toEqual([obsA]);
		expect(request.report).toMatchObject({
			observationsRecorded: 1,
			reflectionsAdded: 1,
			reflectionsReplaced: 0,
			replacementsRecorded: 0,
			reflectionsRetired: 1,
			observationsDropped: 1,
			before: { reflections: 0, observations: 0, reflectionTokens: 0, observationTokens: 0 },
			after: { reflections: 1, observations: 1, reflectionTokens: newRef.tokenCount, observationTokens: obsA.tokenCount },
		});
	});

	it("caps reflection coverage at the cut when an earlier observer run covered entries past it", async () => {
		mockAgents.runReflector.mockResolvedValueOnce([newRef]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			textCustomMessage("raw-3", "cccc"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-3" }),
		];
		const { compact, requestReflect, pi } = setup({ entries });
		requestReflect();

		const result = await compact("raw-2");

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_REFLECTIONS_RECORDED, { reflections: [newRef], coversUpToId: "raw-2" });
		expect(result.compaction.details.reflections).toEqual([newRef]);
		expect(result.compaction.details.observations).toEqual([]);
	});

	it("full-folds even when the observation pool is under its limit", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [oldRef], coversUpToId: "raw-1" }),
			compactionEntry("cmp", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA] }) }),
			textCustomMessage("raw-2", "bbbb"),
		];
		const { compact, requestReflect } = setup({ entries });
		const request = requestReflect();

		const result = await compact("raw-2");

		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.reflections).toEqual([oldRef]);
		expect(request.report.before).toEqual({ reflections: 0, observations: 1, reflectionTokens: 0, observationTokens: 5 });
	});

	it("still folds when a worker fails", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockRejectedValueOnce(new Error("reflector down"));
		const { compact, requestReflect, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")] });
		requestReflect();

		const result = await compact("raw-2");

		expect(runtime.lastReflectorError).toBe("reflector down");
		expect(result.compaction.details).toMatchObject({ fullFold: true, observations: [obsA] });
	});

	it("does not launch auto consolidation while the forced pass runs", async () => {
		const { compact, requestReflect, runtime, turnEnd } = setup({ entries: [textCustomMessage("raw-1", "aaaa")] });
		runtime.config.observeAfterTokens = 1;
		mockAgents.runObserver.mockImplementationOnce(async () => {
			turnEnd();
			return undefined;
		});
		requestReflect();

		await compact("raw-1");

		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("waits for a running background consolidation before the forced pass", async () => {
		const { compact, requestReflect, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaa")] });
		let release!: () => void;
		const order: string[] = [];
		runtime.consolidationPromise = new Promise<void>((resolve) => {
			release = () => {
				order.push("background done");
				resolve();
			};
		});
		mockAgents.runObserver.mockImplementationOnce(async () => {
			order.push("forced observer");
			return undefined;
		});
		requestReflect();

		const pending = compact("raw-1");
		await Promise.resolve();
		release();
		await pending;

		expect(order).toEqual(["background done", "forced observer"]);
	});

	it("delegates to Pi's native summary when the forced pass leaves memory empty", async () => {
		const { compact, requestReflect, runtime } = setup({ entries: [textCustomMessage("raw-1", "aaaa")] });
		const request = requestReflect();

		await expect(compact("raw-1")).resolves.toBeUndefined();
		expect(request.report.after).toBeUndefined();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("leaves compactions without a request unchanged", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [oldRef], coversUpToId: "raw-1" }),
		];
		const { compact, runtime } = setup({ entries });

		const result = await compact("raw-1");

		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(result.compaction.details).toEqual({ type: "om.folded", version: 1, fullFold: false, observations: [obsA], reflections: [] });
	});
});

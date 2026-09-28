import { describe, expect, it, vi } from "vitest";

import { registerReflectCommand } from "../src/commands/reflect.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { renderReflectReport, type ReflectRequest } from "../src/reflect-report.js";
import { textCustomMessage } from "./fixtures/session.js";

function setup(runtimeOverrides: Record<string, unknown> = {}) {
	const handlers: Record<string, (event: unknown, ctx: any) => unknown> = {};
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:reflect");
			handler = command.handler;
		}),
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => unknown) => {
			handlers[eventName] = cb;
		}),
	};
	const runtime = {
		config: { passive: false, compactAfterTokens: 1 },
		ensureConfig: vi.fn(),
		compactInFlight: false,
		compactHookInFlight: false,
		consolidationPromise: null as Promise<void> | null,
		reflectRequest: undefined as ReflectRequest | undefined,
		...runtimeOverrides,
	};
	registerReflectCommand(pi as any, runtime as any);
	registerCompactionTrigger(pi as any, runtime as any);
	const compactCalls: any[] = [];
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { contextWindow: 1000 },
		isIdle: () => true,
		sessionManager: { getBranch: vi.fn(() => [textCustomMessage("raw-1", "a".repeat(400))]) },
		compact: vi.fn((options: any) => {
			compactCalls.push(options);
		}),
	};
	return {
		runtime,
		ctx,
		compactCalls,
		run: () => handler!(undefined, ctx),
		agentSettled: () => handlers.agent_settled!({}, ctx),
	};
}

describe("/om:reflect", () => {
	it("refuses while a compaction is in flight", async () => {
		const { run, ctx, runtime } = setup({ compactInFlight: true });

		await run();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.reflectRequest).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
	});

	it("sets a one-shot request, blocks auto compaction, and reports on completion", async () => {
		vi.useFakeTimers();
		try {
			const { run, ctx, runtime, compactCalls, agentSettled } = setup();

			await run();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
			expect(runtime.reflectRequest).toBeDefined();
			expect(runtime.compactInFlight).toBe(true);

			agentSettled();
			await vi.runAllTimersAsync();
			expect(ctx.compact).toHaveBeenCalledTimes(1);

			const request = runtime.reflectRequest!;
			request.report.started = true;
			runtime.reflectRequest = undefined;
			request.report.reflectionsAdded = 2;
			compactCalls[0].onComplete({});

			expect(runtime.compactInFlight).toBe(false);
			expect(ctx.ui.notify).toHaveBeenLastCalledWith(renderReflectReport(request.report), "info");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports nothing to compact when Pi rejects before the hook runs", async () => {
		const { run, ctx, runtime, compactCalls } = setup();

		await run();
		compactCalls[0].onError(new Error("Nothing to compact (session too small)"));

		expect(runtime.reflectRequest).toBeUndefined();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("nothing to compact yet"), "info");
	});

	it("reports a failure after the forced pass started", async () => {
		const { run, ctx, runtime, compactCalls } = setup();

		await run();
		runtime.reflectRequest!.report.started = true;
		runtime.reflectRequest = undefined;
		compactCalls[0].onError(new Error("boom"));

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("/om:reflect failed: boom"), "error");
	});

	it("waits for a running consolidation before compacting", async () => {
		let release!: () => void;
		const { run, ctx } = setup({ consolidationPromise: new Promise<void>((resolve) => { release = resolve; }) });

		const pending = run();
		await Promise.resolve();
		expect(ctx.compact).not.toHaveBeenCalled();
		release();
		await pending;

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});
});

describe("reflect report", () => {
	it("renders pass counts and before/after summary sizes", () => {
		const text = renderReflectReport({
			started: true,
			observationsRecorded: 3,
			reflectionsAdded: 2,
			reflectionsReplaced: 4,
			replacementsRecorded: 1,
			reflectionsRetired: 5,
			observationsDropped: 6,
			before: { reflections: 10, observations: 20, reflectionTokens: 100, observationTokens: 200 },
			after: { reflections: 4, observations: 14, reflectionTokens: 40, observationTokens: 150 },
		});

		expect(text).toContain("Observations: +3 recorded, -6 dropped");
		expect(text).toContain("Reflections: +2 new, 4 replaced by 1, 5 retired");
		expect(text).toContain("Summary reflections: 10 → 4 (~100 → ~40 tokens)");
		expect(text).toContain("Summary observations: 20 → 14 (~200 → ~150 tokens)");
	});
});

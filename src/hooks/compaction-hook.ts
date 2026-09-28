import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { debugLog, withDebugLogContext } from "../debug-log.js";
import { memorySize, type ReflectRequest } from "../reflect-report.js";
import type { Runtime } from "../runtime.js";
import { buildCompactionProjection, renderSummary, visibleProjection, type Entry } from "../session-ledger/index.js";
import { runConsolidationPipeline } from "./consolidation-trigger.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

/**
 * The /om:reflect pass: run every memory worker now, under the consolidation lock, with everything it writes
 * capped at the compaction cut so it lands in this fold. Worker failures are recorded by the pipeline.
 */
async function runReflectPass(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	request: ReflectRequest,
): Promise<void> {
	request.report.started = true;
	request.report.before = memorySize(visibleProjection(ctx.sessionManager.getBranch() as Entry[]));
	if (runtime.consolidationPromise) await runtime.consolidationPromise.catch(() => undefined);
	const debugContext = {
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId?.(),
		sessionFile: ctx.sessionManager.getSessionFile?.(),
		runId: `reflect-${Date.now().toString(36)}`,
	};
	await withDebugLogContext(debugContext, async () => {
		const startedAt = Date.now();
		debugLog("reflect.pass_start", { firstKeptEntryId: event.preparation.firstKeptEntryId });
		await runtime.launchConsolidationTask(ctx, () => runConsolidationPipeline(pi, runtime, ctx, {
			forceObservation: true,
			forceReflection: true,
			coverageLimitId: event.preparation.firstKeptEntryId,
			signal: event.signal,
			report: request.report,
		}));
		debugLog("reflect.pass_done", { ...request.report, elapsedMs: Date.now() - startedAt });
	});
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			// Consume the one-shot /om:reflect request before any await so no later compaction repeats it.
			const reflectRequest = runtime.reflectRequest;
			runtime.reflectRequest = undefined;
			if (reflectRequest) await runReflectPass(pi, runtime, ctx, event, reflectRequest);
			// The forced pass appended ledger entries, so fold the live branch rather than the event snapshot.
			const entries = (reflectRequest ? ctx.sessionManager.getBranch() : branchEntries) as Entry[];
			const projection = buildCompactionProjection(
				entries,
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime), forceFullFold: reflectRequest !== undefined },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			if (reflectRequest && summary.length > 0) reflectRequest.report.after = memorySize(projection);
			if (summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}

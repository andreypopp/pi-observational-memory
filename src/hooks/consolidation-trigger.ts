import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { ObserverStreamError, runObserver } from "../agents/observer/agent.js";
import { renderProjectContext } from "../agents/project-context.js";
import { runReflector } from "../agents/reflector/agent.js";
import { runReflectionReview } from "../agents/reviewer/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import type { ConsolidationReport } from "../reflect-report.js";
import { resolveObserverChunkMaxTokens, resolveProjectContextMaxTokens } from "../config.js";
import { resolveProjectContextFiles, type ResolvedProjectContextFiles } from "./project-context.js";
import type { ConsolidationPhase, ResolveCtx, ResolveResult, Runtime } from "../runtime.js";
import { fmtLocal, serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsDroppedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

export type ConsolidationOptions = {
	/** Run the reflector regardless of its token clock, and review reflections even when it records nothing new. */
	forceReflection?: boolean;
	/** Run the observer regardless of its token clock and deliberate-empty backoff. */
	forceObservation?: boolean;
	/**
	 * Keep this pass at or before a compaction cut: the observer reads source entries only through this id,
	 * and every entry the pass writes has its coversUpToId capped at it, so the pass lands in that fold.
	 */
	coverageLimitId?: string;
	/** Aborts running workers (the compaction's signal for /om:reflect). */
	signal?: AbortSignal;
	/** Accumulates what the pass recorded. */
	report?: ConsolidationReport;
};

function capCoverage(entries: Entry[], coversUpToId: string | undefined, options: ConsolidationOptions): string | undefined {
	return options.coverageLimitId ? earlierCoverageMarkerId(entries, coversUpToId, options.coverageLimitId) : coversUpToId;
}

type ReflectorStageResult = {
	outcome: StageOutcome;
	/** Reflections recorded this run: crystallized ones and review replacements. */
	sameRunReflections: Reflection[];
	/** Set when crystallize or review recorded anything; the dropper runs only then. */
	effectiveReflectionCoverageId?: string;
};

/** Local "YYYY-MM-DD HH:MM", the same shape as observation timestamps. */
function formatRecordedAt(timestamp: string | undefined): string | undefined {
	if (!timestamp) return undefined;
	const d = new Date(timestamp);
	return Number.isNaN(d.getTime()) ? undefined : fmtLocal(d);
}

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate, which
	// self-limits after coverage and cannot over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function workerHeadersFor(ctx: ConsolidationCtx, resolved: ResolvedModel): ResolvedModel {
	// Console Go (opencode.ai) rejects requests without x-opencode-session
	// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
	const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
	if (
		model.provider !== "opencode"
		&& model.provider !== "opencode-go"
		&& !(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
	) {
		return resolved;
	}
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return resolved;
	return {
		...resolved,
		headers: {
			...(resolved.headers ?? {}),
			"x-opencode-session": sessionId,
			"x-opencode-client": "pi",
		},
	};
}

/** Thinking level for the worker call: the fallback's or reflector model's own setting wins when that model is active. */
function workerThinkingLevel(runtime: Runtime, resolved: ResolvedModel) {
	if (resolved.reflectorModelUsed === true) {
		return runtime.config.reflectorModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	if (resolved.fallbackUsed === true) {
		return runtime.config.fallbackModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	return runtime.config.model?.thinking ?? "low";
}

/**
 * Context window the observer chunk is sized against. The chunk is serialized
 * once and reused verbatim if the run falls back mid-call, so cap it to the
 * smaller of the primary and fallback windows: otherwise a large-context primary
 * plus a small-context fallback would send the fallback an over-context chunk and
 * make the retry fail for a reason the fallback cannot fix. When no fallback is
 * configured this is exactly the primary model's window.
 */
function observerChunkContextWindow(runtime: Runtime, ctx: ConsolidationCtx, resolved: ResolvedModel): number | undefined {
	const primary = (resolved.model as { contextWindow?: number } | undefined)?.contextWindow;
	const fallback = runtime.config.fallbackModel;
	if (!fallback) return primary;
	const fallbackModel = ctx.modelRegistry.find?.(fallback.provider, fallback.id) as { contextWindow?: number } | undefined;
	const usablePrimary = typeof primary === "number" && primary > 0 ? primary : undefined;
	const fallbackWindow = fallbackModel?.contextWindow;
	const usableFallback = typeof fallbackWindow === "number" && fallbackWindow > 0 ? fallbackWindow : undefined;
	if (usablePrimary === undefined) return usableFallback;
	if (usableFallback === undefined) return usablePrimary;
	return Math.min(usablePrimary, usableFallback);
}

/**
 * Render the project context for one reflector call, capped for the model that call runs on,
 * and log what it carried. "" when there are no files.
 */
function projectContextFor(
	runtime: Runtime,
	projectFiles: ResolvedProjectContextFiles,
	worker: ResolvedModel,
	call: "crystallize" | "review",
): string {
	const contextWindow = (worker.model as { contextWindow?: number } | undefined)?.contextWindow;
	const maxTokens = resolveProjectContextMaxTokens(runtime.config, contextWindow);
	const rendered = renderProjectContext(projectFiles.files, maxTokens);
	debugLog("reflector.project_context", {
		call,
		source: projectFiles.source,
		fileCount: rendered.fileCount,
		estimatedTokens: rendered.estimatedTokens,
		maxTokens,
		omitted: rendered.omitted.map((file) => file.path),
	});
	return rendered.text;
}

type ModelResolver = {
	resolve: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
	/** Resolve the configured fallback, caching it for the rest of the pass. */
	resolveFallback: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
};

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): ModelResolver {
	let cached: ResolveResult | undefined;
	// Once the fallback proves usable, keep it for the rest of the pass so later
	// stages do not re-pay a known-broken primary.
	let fallbackActive: ResolvedModel | undefined;
	let reflectorCached: ResolveResult | undefined;

	const resolve = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (stage === "reflector" && runtime.config.reflectorModel && typeof runtime.resolveReflectorModel === "function") {
			reflectorCached ??= await runtime.resolveReflectorModel({
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
			});
			if (reflectorCached.ok) {
				runtime.reflectorModelFailureNotified = false;
				return workerHeadersFor(ctx, reflectorCached);
			}
			debugLog("reflector.reflector_model_unavailable", { reason: reflectorCached.reason });
			if (!runtime.reflectorModelFailureNotified && ctx.hasUI && ctx.ui) {
				ctx.ui.notify(`Observational memory: ${reflectorCached.reason}; reflector uses the memory model`, "warning");
				runtime.reflectorModelFailureNotified = true;
			}
		}
		if (fallbackActive) {
			runtime.resolveFailureNotified = false;
			return fallbackActive;
		}
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return workerHeadersFor(ctx, cached);
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};

	const resolveFallback = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) return fallbackActive;
		const resolveFallbackModel = runtime.resolveFallbackModel;
		if (typeof resolveFallbackModel !== "function") {
			debugLog(`${stage}.fallback_unavailable`, { reason: "runtime exposes no resolveFallbackModel" });
			return undefined;
		}
		const resolvedCtx: ResolveCtx = {
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		};
		const result = await resolveFallbackModel.call(runtime, resolvedCtx);
		if (!result.ok) {
			debugLog(`${stage}.fallback_unavailable`, { reason: result.reason });
			return undefined;
		}
		const resolved = workerHeadersFor(ctx, { ...result, fallbackUsed: true });
		fallbackActive = resolved;
		debugLog(`${stage}.fallback_active`, {
			provider: (resolved.model as { provider?: string })?.provider,
			id: (resolved.model as { id?: string })?.id,
		});
		return resolved;
	};

	return { resolve, resolveFallback };
}

/**
 * Run one worker stage against the resolved primary model, retrying once with the
 * configured fallback model when the call throws. A stage that already resolved
 * through the fallback (resolution-time fallback) is not retried again — its error
 * is final. The last error thrown is what the caller sees, so the existing
 * stream-error classification and failure recording stay intact.
 */
async function runStageWithFallback<T>(
	ctx: ConsolidationCtx,
	stage: ConsolidationPhase,
	resolved: ResolvedModel,
	resolver: ModelResolver,
	work: (model: ResolvedModel) => Promise<T>,
): Promise<T> {
	try {
		return await work(resolved);
	} catch (primaryError) {
		if (resolved.fallbackUsed === true) throw primaryError;
		const fallback = await resolver.resolveFallback(stage);
		if (!fallback) throw primaryError;
		const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
		debugLog(`${stage}.fallback_retry`, {
			primaryError: message,
			provider: (fallback.model as { provider?: string })?.provider,
			id: (fallback.model as { id?: string })?.id,
		});
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.notify(
				`Observational memory: ${stage} failed (${message}); retrying with fallback model`,
				"warning",
			);
		}
		return await work(fallback);
	}
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationOptions = {},
): Promise<void> {
	const resolver = makeModelResolver(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolver, options);
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolver, options);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolver, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId, options);
	} catch (error) {
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	options: ConsolidationOptions,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens) : undefined;
	const tokens = real !== undefined ? real : rawTokensSinceObservationCoverage(entries); // fallback: no usage baseline / basis change
	if (!options.forceObservation && tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = options.forceObservation ? undefined : runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolver.resolve("observer");
	if (!resolved) return "abort";

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	// A coverage limit keeps the chunk at or before the compaction cut; an unknown limit id does not limit.
	const limitIdx = options.coverageLimitId ? entries.findIndex((entry) => entry.id === options.coverageLimitId) : -1;
	const backlogEntries = sourceEntriesAfter(limitIdx === -1 ? entries : entries.slice(0, limitIdx + 1), lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = observerChunkContextWindow(runtime, ctx, resolved);
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = capCoverage(entries, sourceEntryIds.at(-1), options);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	// Full projection at the tip applies reflection retirements, so only active reflections reach the observer.
	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	let observations: Observation[] | undefined;
	try {
		observations = await runStageWithFallback(ctx, "observer", resolved, resolver, (worker) => runObserver({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			signal: options.signal,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}));
	} catch (error) {
		if (error instanceof ObserverStreamError) {
			// API/stream failure is not a clean empty (#32): surface it as a real
			// failure instead of the "no observations" path. Coverage stays put.
			runtime.recordConsolidationStageError(ctx, "observer", error);
			return "abort";
		}
		throw error;
	}
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	if (options.report) options.report.observationsRecorded += observations.length;
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	options: ConsolidationOptions,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens) : undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (!options.forceReflection && reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = capCoverage(entries, latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED), options);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const resolved = await resolver.resolve("reflector");
	if (!resolved) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const projectFiles = resolveProjectContextFiles(runtime, ctx.cwd);
	const reflections = await runStageWithFallback(ctx, "reflector", resolved, resolver, (worker) => runReflector({
		model: worker.model as any,
		apiKey: worker.apiKey,
		headers: worker.headers,
		env: worker.env,
		reflections: folded.activeReflections,
		knownReflectionIds: folded.knownReflectionIds,
		observations: folded.activeObservations,
		projectContext: projectContextFor(runtime, projectFiles, worker, "crystallize"),
		signal: options.signal,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: workerThinkingLevel(runtime, worker),
		modelRegistry: ctx.modelRegistry,
	}));
	const sameRunReflections: Reflection[] = [];
	const data = reflections ? buildReflectionsRecordedData(reflections, observationCoverageId) : undefined;
	if (data) {
		appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
		sameRunReflections.push(...data.reflections);
		if (options.report) options.report.reflectionsAdded += data.reflections.length;
	}

	let reviewRecorded = false;
	if (data || options.forceReflection) {
		const replacements = await runReviewStep(pi, runtime, ctx, resolver, observationCoverageId, new Set(sameRunReflections.map((reflection) => reflection.id)), projectFiles, options);
		if (replacements) {
			reviewRecorded = true;
			sameRunReflections.push(...replacements);
		}
	}

	return {
		outcome: "continue",
		sameRunReflections,
		effectiveReflectionCoverageId: (data || reviewRecorded) ? observationCoverageId : undefined,
	};
}

/**
 * Review active reflections after crystallize: retire stale ones and replace verbose or overlapping ones.
 * Runs on the reflector's model with its fallback retry. A failure is recorded as a review error but keeps
 * crystallize's output. Returns the recorded replacements when the review wrote anything, else undefined.
 */
async function runReviewStep(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	coversUpToId: string,
	newReflectionIds: ReadonlySet<string>,
	projectFiles: ResolvedProjectContextFiles,
	options: ConsolidationOptions,
): Promise<Reflection[] | undefined> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	if (folded.activeReflections.length === 0) return undefined;
	const resolved = await resolver.resolve("reflector");
	if (!resolved) return undefined;

	const recordedAt = new Map<string, string>();
	for (const [id, timestamp] of folded.reflectionRecordedAt) {
		const formatted = formatRecordedAt(timestamp);
		if (formatted) recordedAt.set(id, formatted);
	}
	const reflectionCount = folded.activeReflections.length;
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflection review running over ${reflectionCount} reflection${reflectionCount === 1 ? "" : "s"}`,
		"info",
	);
	debugLog("reflector.review_start", {
		reflectionCount,
		newReflectionCount: newReflectionIds.size,
		observationCount: folded.activeObservations.length,
	});
	const startedAt = Date.now();

	let result: Awaited<ReturnType<typeof runReflectionReview>>;
	runtime.consolidationPhase = "review";
	try {
		result = await runStageWithFallback(ctx, "reflector", resolved, resolver, (worker) => runReflectionReview({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			reflections: folded.activeReflections,
			newReflectionIds,
			retiredReflectionIds: folded.retiredReflectionIds,
			recordedAt,
			observations: folded.activeObservations,
			projectContext: projectContextFor(runtime, projectFiles, worker, "review"),
			signal: options.signal,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}));
	} catch (error) {
		debugLog("reflector.review_error", {
			errorMessage: runtime.recordConsolidationStageError(ctx, "review", error),
			elapsedMs: Date.now() - startedAt,
		});
		return undefined;
	} finally {
		runtime.consolidationPhase = "reflector";
	}

	let wrote = false;
	const replacementData = result ? buildReflectionsRecordedData(result.replacements, coversUpToId) : undefined;
	if (replacementData) {
		appendEntry(pi, OM_REFLECTIONS_RECORDED, replacementData);
		if (options.report) options.report.replacementsRecorded += replacementData.reflections.length;
		wrote = true;
	}
	for (const retirement of result?.retirements ?? []) {
		const data = buildReflectionsDroppedData(retirement.reflectionIds, coversUpToId, retirement.replacedBy, retirement.kind);
		if (!data) continue;
		appendEntry(pi, OM_REFLECTIONS_DROPPED, data);
		if (options.report) {
			if (data.replacedBy) options.report.reflectionsReplaced += data.reflectionIds.length;
			else options.report.reflectionsRetired += data.reflectionIds.length;
		}
		wrote = true;
	}
	debugLog("reflector.review_done", {
		replacementCount: result?.replacements.length ?? 0,
		retiredCount: result?.retirements.reduce((sum, retirement) => sum + retirement.reflectionIds.length, 0) ?? 0,
		retirementEntryCount: result?.retirements.length ?? 0,
		coversUpToId,
		elapsedMs: Date.now() - startedAt,
	});
	return wrote ? result!.replacements : undefined;
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
	options: ConsolidationOptions,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const resolved = await resolver.resolve("dropper");
	if (!resolved) return "abort";

	// A same-run reflection can reuse the id of a retired one; the tombstone keeps it retired, so it is not coverage.
	const reflectionsForDropper = mergeReflections(
		folded.activeReflections,
		sameRunReflections.filter((reflection) => !folded.retiredReflectionIds.has(reflection.id)),
	);
	const droppedIds = await runStageWithFallback(ctx, "dropper", resolved, resolver, (worker) => runDropper({
		model: worker.model as any,
		apiKey: worker.apiKey,
		headers: worker.headers,
		env: worker.env,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		signal: options.signal,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: workerThinkingLevel(runtime, worker),
		modelRegistry: ctx.modelRegistry,
	}));
	const coversUpToId = capCoverage(entries, earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId), options);
	const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) {
		appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
		if (options.report) options.report.observationsDropped += data.observationIds.length;
	}
	return "continue";
}

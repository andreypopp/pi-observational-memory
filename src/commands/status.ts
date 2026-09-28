import { relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { renderProjectContext } from "../agents/project-context.js";
import { resolveCompactAfterTokens, resolveProjectContextMaxTokens } from "../config.js";
import { resolveProjectContextFiles } from "../hooks/project-context.js";
import { blockTokens, parsePromotedMemory, readPromotedMemory } from "../project-memory/memory-file.js";
import { resolvePromoteTarget } from "../project-memory/target.js";
import type { Runtime } from "../runtime.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

/**
 * Context window of the model the reflector runs on, resolved like the reflector stage does: the reflector
 * model when configured and usable, else the memory model (primary, then fallback). Undefined when neither resolves.
 */
async function reflectorContextWindow(runtime: Runtime, ctx: { model?: unknown; modelRegistry?: unknown }): Promise<number | undefined> {
	const resolveCtx = { model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: false };
	try {
		let resolved = runtime.config.reflectorModel ? await runtime.resolveReflectorModel(resolveCtx) : undefined;
		if (!resolved?.ok) resolved = await runtime.resolveModel(resolveCtx);
		const contextWindow = resolved.ok ? (resolved.model as { contextWindow?: unknown } | undefined)?.contextWindow : undefined;
		return typeof contextWindow === "number" ? contextWindow : undefined;
	} catch {
		return undefined;
	}
}

/** "Project context: …" status line, only when the reflector would see context files. */
async function projectContextLine(runtime: Runtime, ctx: { cwd: string; model?: unknown; modelRegistry?: unknown }): Promise<string[]> {
	const { files } = resolveProjectContextFiles(runtime, ctx.cwd);
	if (files.length === 0) return [];
	const rendered = renderProjectContext(files, resolveProjectContextMaxTokens(runtime.config, await reflectorContextWindow(runtime, ctx)));
	const omitted = rendered.omitted.length > 0 ? ` (${rendered.omitted.length} omitted)` : "";
	return [`Project context: ${rendered.fileCount} file(s), ~${rendered.estimatedTokens.toLocaleString()} tokens${omitted}`];
}

/** "Promoted: …" status line, only when the project has a `.memory.md`. */
function promotedLine(cwd: string): string[] {
	try {
		const target = resolvePromoteTarget(cwd);
		const raw = readPromotedMemory(target.memoryPath);
		if (raw === undefined) return [];
		const parsed = parsePromotedMemory(raw);
		const tokens = blockTokens(parsed.lines.map((line) => line.raw.trim()));
		const path = relative(cwd, target.memoryPath) || target.memoryPath;
		return [`Promoted: ${parsed.lines.length} line${parsed.lines.length === 1 ? "" : "s"} (~${tokens.toLocaleString()} tokens) in ${path}`];
	} catch {
		return [];
	}
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const visibleReflectionTokens = tokenSum(visible.reflections);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const retiredReflectionCount = folded.reflections.length - folded.activeReflections.length;
			// Retirement counts appear only once a reflection has been retired, keeping older status output unchanged.
			const reflectionCounts = retiredReflectionCount > 0
				? `${folded.reflections.length} recorded / ${retiredReflectionCount} retired / ${folded.activeReflections.length} active / ${visible.reflections.length} visible`
				: `${folded.reflections.length} recorded / ${visible.reflections.length} visible`;
			const reflectionLine = appendSuffixes(
				`Reflections:  ${reflectionCounts}`,
				[
					addedSuffix(drift.reflectionsOnlyInFull.length),
					removedSuffix(drift.reflectionsRetiredOnlyInFull.length),
				],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

			const passiveLines = runtime.config.passive === true
				? [
					"── Mode ──",
					"Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active",
					"",
				]
				: [];

			const lines = [
				...passiveLines,
				"── Memory ──",
				observationLine,
				reflectionLine,
				...(await projectContextLine(runtime, ctx)),
				...promotedLine(ctx.cwd),
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Reflection pool:         ~${visibleReflectionTokens.toLocaleString()} tokens`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastReviewError || runtime.lastDropperError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastReviewError) lines.push(`Review: ${runtime.lastReviewError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

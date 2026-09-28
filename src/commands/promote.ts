import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderProjectContext } from "../agents/project-context.js";
import { runPromoter } from "../agents/promoter/agent.js";
import { resolveProjectContextMaxTokens } from "../config.js";
import { debugLog } from "../debug-log.js";
import {
	formatRecordedAt,
	makeModelResolver,
	runStageWithFallback,
	workerThinkingLevel,
	type ConsolidationCtx,
} from "../hooks/consolidation-trigger.js";
import { contextFilesWithoutMemoryFile, resolveProjectContextFiles } from "../hooks/project-context.js";
import { parsePromotedMemory, readPromotedMemory } from "../project-memory/memory-file.js";
import {
	applyPromotePlan,
	promotedLineRecords,
	buildPromotePlan,
	planChangesSomething,
	promoteSummary,
	renderPromotePreview,
	type ApplyResult,
	type PromotePlan,
} from "../project-memory/promote.js";
import { resolvePromoteTarget } from "../project-memory/target.js";
import { compactionBusy, isBusy, type Runtime } from "../runtime.js";
import { commandNotify, type Notify } from "./notify.js";
import { statusWidget, type StatusWidget } from "./status-widget.js";
import { foldLedger, type Entry } from "../session-ledger/index.js";

export const PROMOTE_STATUS_WIDGET = "om-promote";

/**
 * Run `work` holding the consolidation lock, after any running consolidation: no memory worker starts
 * meanwhile, and a compaction hook waits for it like it waits for a consolidation.
 */
export async function withConsolidationLock<T>(runtime: Runtime, notify: Notify, work: () => Promise<T>, doing = "promoting"): Promise<T> {
	let notified = false;
	while (runtime.consolidationPromise) {
		if (!notified) notify(`Observational memory: waiting for running memory workers before ${doing}`, "info");
		notified = true;
		await runtime.consolidationPromise.catch(() => undefined);
	}
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	runtime.consolidationInFlight = true;
	runtime.consolidationPromise = promise;
	try {
		return await work();
	} finally {
		runtime.consolidationInFlight = false;
		if (runtime.consolidationPromise === promise) runtime.consolidationPromise = null;
		release();
	}
}

/** How confirmAndApplyPlan ended; "applied" carries applyPromotePlan's result, which can still refuse. */
export type ConfirmedApply = { status: "preview only" } | { status: "declined" } | { status: "busy" } | { status: "applied"; result: ApplyResult };

/**
 * Preview a plan, ask to apply it and apply it against the live branch under the consolidation lock.
 * Without UI it only prints the preview and `noUiNote`.
 */
export async function confirmAndApplyPlan(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	notify: Notify,
	status: StatusWidget,
	plan: PromotePlan,
	options: {
		ui: ExtensionCommandContext["ui"] | undefined;
		previewTitle?: string;
		/** Lines after the plan preview. */
		previewDetails?: string[];
		noUiNote: string;
		confirmTitle: string;
		/** Status line prefix while writing, like "Promoting memory". */
		statusLabel: string;
		/** What the lock's wait notice says is waiting; withConsolidationLock's default when unset. */
		doing?: string;
	},
): Promise<ConfirmedApply> {
	const { ui } = options;
	const preview = [renderPromotePreview(plan, ctx.cwd, runtime.config.promoteMaxTokens, options.previewTitle), ...(options.previewDetails ?? [])].join("\n");
	if (!ui) {
		console.log(`${preview}\n\n${options.noUiNote}`);
		return { status: "preview only" };
	}
	ui.notify(preview, "info");
	if (!(await ui.confirm(options.confirmTitle, promoteSummary(plan, ctx.cwd)))) return { status: "declined" };
	if (compactionBusy(runtime)) return { status: "busy" };
	status.show(`${options.statusLabel}: writing ${basename(plan.target.memoryPath)} and .memory/…`);
	const result = await withConsolidationLock(runtime, notify, async () => {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		return applyPromotePlan(plan, entries, foldLedger(entries), (customType, data) => pi.appendEntry(customType, data), ctx.cwd);
	}, options.doing);
	return { status: "applied", result };
}

/** Ask the model for a new block and turn it into a plan. Undefined (after notifying) when there is nothing to do. */
async function proposePromotion(runtime: Runtime, ctx: ExtensionCommandContext, notify: Notify, status: StatusWidget): Promise<PromotePlan | undefined> {
	const target = resolvePromoteTarget(ctx.cwd);
	const originalContent = readPromotedMemory(target.memoryPath);
	const parsed = parsePromotedMemory(originalContent ?? "");
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	if (folded.activeReflections.length === 0 && parsed.lines.length === 0) {
		notify("Observational memory: no active reflections to promote yet", "info");
		return undefined;
	}

	const consolidationCtx = ctx as unknown as ConsolidationCtx;
	const resolver = makeModelResolver(runtime, consolidationCtx);
	const resolved = await resolver.resolve("reflector");
	if (!resolved) {
		notify("Observational memory: /om:promote needs a memory model; none resolved", "error");
		return undefined;
	}
	const recordedAt = new Map<string, string>();
	for (const [id, timestamp] of folded.reflectionRecordedAt) {
		const formatted = formatRecordedAt(timestamp);
		if (formatted) recordedAt.set(id, formatted);
	}
	const contextFiles = contextFilesWithoutMemoryFile(resolveProjectContextFiles(runtime, ctx.cwd).files, target);
	notify(`Observational memory: choosing reflections to promote from ${folded.activeReflections.length} active`, "info");
	status.show(`Promoting memory: choosing reflections… (${folded.activeReflections.length} active)`);
	const proposal = await runStageWithFallback(consolidationCtx, "reflector", resolved, resolver, (worker) => {
		const contextWindow = (worker.model as { contextWindow?: number } | undefined)?.contextWindow;
		return runPromoter({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			promotedLines: parsed.lines,
			lineRecords: promotedLineRecords(parsed.lines, folded, target.memoryDir),
			activeReflections: folded.activeReflections,
			recordedAt,
			retiredReflectionIds: folded.retiredReflectionIds,
			projectContext: renderProjectContext(contextFiles, resolveProjectContextMaxTokens(runtime.config, contextWindow)).text,
			maxPromotedTokens: runtime.config.promoteMaxTokens,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: consolidationCtx.modelRegistry,
		});
	});
	if (!proposal) {
		notify("Observational memory: nothing to promote; the block stays as it is", "info");
		return undefined;
	}
	const plan = buildPromotePlan({
		target,
		originalContent,
		proposedLines: proposal.lines,
		folded,
		sessionId: ctx.sessionManager.getSessionId?.(),
		promotedAt: new Date().toISOString(),
	});
	if (!planChangesSomething(plan)) {
		notify("Observational memory: nothing to promote; the block stays as it is", "info");
		return undefined;
	}
	return plan;
}

export function registerPromoteCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:promote", {
		description: "Promote durable project facts from memory into the project's .memory.md and .memory/",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const hasUI = ctx.hasUI;
			const ui = ctx.ui;
			const notify = commandNotify(ctx);

			if (isBusy(runtime)) {
				notify("Observational memory: a compaction or promotion is already running; try /om:promote again when it finishes", "warning");
				return;
			}
			runtime.promoteInFlight = true;
			const status = statusWidget(ctx, PROMOTE_STATUS_WIDGET);
			try {
				let plan: PromotePlan | undefined;
				try {
					plan = await withConsolidationLock(runtime, notify, () => proposePromotion(runtime, ctx, notify, status));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					debugLog("promote.error", { errorMessage: message });
					notify(`Observational memory: /om:promote failed: ${message}`, "error");
					return;
				} finally {
					status.hide();
				}
				if (!plan) return;

				const applied = await confirmAndApplyPlan(pi, runtime, ctx, notify, status, plan, {
					ui: hasUI ? ui : undefined,
					noUiNote: "/om:promote needs an interactive session to apply; nothing was written.",
					confirmTitle: "Promote memory?",
					statusLabel: "Promoting memory",
				});
				if (applied.status === "preview only") return;
				if (applied.status === "declined") {
					notify("Observational memory: /om:promote cancelled; nothing was written", "info");
					return;
				}
				if (applied.status === "busy") {
					notify("Observational memory: a compaction started meanwhile; nothing was written. Run /om:promote again when it finishes", "warning");
					return;
				}
				const { result } = applied;
				status.hide();
				if (!result.ok) {
					notify(`Observational memory: nothing was written: ${result.reason}. Run /om:promote again`, "warning");
					return;
				}
				debugLog("promote.applied", {
					lines: plan.proposedLines.length,
					tokens: plan.tokens,
					memoryFilesWritten: result.memoryFilesWritten.length,
					memoryFilesRemoved: result.memoryFilesRemoved.length,
					promoted: plan.promotedIds.length,
				});
				notify(
					`Observational memory: promoted ${plan.promotedIds.length} line(s) into ${plan.target.memoryPath}, wrote ${result.memoryFilesWritten.length} and removed ${result.memoryFilesRemoved.length} .memory file(s). The main agent sees them from its next prompt; commit .memory.md and .memory/ together.`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				debugLog("promote.error", { errorMessage: message });
				notify(`Observational memory: /om:promote failed: ${message}`, "error");
			} finally {
				status.hide();
				runtime.promoteInFlight = false;
			}
		},
	});
}

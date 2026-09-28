import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug-log.js";
import { runReflectPass } from "../hooks/compaction-hook.js";
import { refreshProjectContextFromCommand, stripBom } from "../hooks/project-context.js";
import { BlockMarkerError, parseContextFile, type ParsedContextFile } from "../project-memory/block.js";
import { buildGroundBlockPlan } from "../project-memory/ground.js";
import { applyPromotePlan, promoteSummary, readContextFile, renderPromotePreview } from "../project-memory/promote.js";
import { displayPath, resolvePromoteTarget } from "../project-memory/target.js";
import {
	emptyReflectReport,
	renderGroundReport,
	type GroundBlockOutcome,
	type GroundingRequest,
	type PassProgressDetail,
	type PassStage,
	type ReflectRequest,
} from "../reflect-report.js";
import { compactionBusy, isBusy, type Runtime } from "../runtime.js";
import { foldLedger, type Entry } from "../session-ledger/index.js";
import { commandNotify, type Notify } from "./notify.js";
import { isNothingToCompact } from "./reflect.js";
import { withConsolidationLock } from "./promote.js";
import { statusWidget, type StatusWidget } from "./status-widget.js";

export const GROUND_STATUS_WIDGET = "om-ground";

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

const STAGE_LABELS: Record<Exclude<PassStage, "review">, string> = {
	observer: "observing…",
	reflector: "reflecting…",
	dropper: "dropping observations…",
	fold: "folding memory…",
};

type GroundProgress = {
	stage: (stage: PassStage, detail?: PassProgressDetail) => void;
	/** Show a spinner from now on: outside the compaction hook, where Pi shows none. */
	useSpinner: () => void;
	stop: () => void;
};

/**
 * Stage labels with elapsed time, refreshed every second. Inside the compaction hook Pi already shows
 * "Compacting context…" with its spinner, so the label is a plain line there.
 */
function groundProgress(status: StatusWidget, grounding: GroundingRequest): GroundProgress {
	const startedAt = Date.now();
	const blockName = basename(grounding.target.contextPath);
	let spinner = false;
	let text: (() => string) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const render = () => {
		if (text) status.show(`Grounding: ${text()} ${formatElapsed(Date.now() - startedAt)}`, { spinner });
	};
	grounding.onToolCall = render;
	return {
		stage(stage, detail) {
			if (stage === "review") {
				const reflections = detail?.reflections ?? 0;
				const lines = grounding.parsed.lines.length;
				text = () => `checking ${reflections} reflection${reflections === 1 ? "" : "s"} and ${lines} ${blockName} line${lines === 1 ? "" : "s"} against the repo… ${grounding.toolCalls} tool call${grounding.toolCalls === 1 ? "" : "s"},`;
			} else {
				text = () => STAGE_LABELS[stage];
			}
			render();
			if (!timer) {
				timer = setInterval(render, 1000);
				timer.unref?.();
			}
		},
		useSpinner() {
			spinner = true;
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
			text = undefined;
			grounding.onToolCall = undefined;
			status.hide();
		},
	};
}

/**
 * After the pass: turn the block revisions into a plan against the live branch and the file as it is
 * now, preview it, and apply it on confirmation, like /om:promote. Without UI it only prints the preview.
 */
async function applyBlockRevisions(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	grounding: GroundingRequest,
	notify: Notify,
	status: StatusWidget,
): Promise<GroundBlockOutcome> {
	if (grounding.blockRevisions.length === 0) return { rewritten: 0, removed: 0, status: "no changes" };
	runtime.promoteInFlight = true;
	try {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const built = buildGroundBlockPlan({
			target: grounding.target,
			reviewedLines: grounding.parsed.lines,
			revisions: grounding.blockRevisions,
			folded: foldLedger(entries),
			sessionId: ctx.sessionManager.getSessionId?.(),
			promotedAt: new Date().toISOString(),
			cwd: ctx.cwd,
		});
		const counts = { rewritten: grounding.blockRevisions.filter((r) => r.action === "rewrite").length, removed: grounding.blockRevisions.filter((r) => r.action === "remove").length };
		if (!built.ok) return { ...counts, status: `not applied: ${built.reason}` };
		const { plan } = built;
		const outcome = (status: string): GroundBlockOutcome => ({ rewritten: built.rewritten, removed: built.removed, status });
		const reasons = grounding.blockRevisions.map((revision) => `- [${revision.id}] ${revision.action}: ${revision.reason}`);
		const staleText = grounding.staleText.map((item) => `- ${item.path}: "${item.excerpt}" — ${item.reason}`);
		const preview = [
			renderPromotePreview(plan, ctx.cwd, runtime.config.promoteMaxTokens, "Observational memory: /om:ground block preview"),
			"",
			"Evidence:",
			...reasons,
			...(staleText.length > 0 ? ["", "Stale hand-written text (reported only, not edited):", ...staleText] : []),
		].join("\n");
		if (!ctx.hasUI || !ctx.ui) {
			console.log(`${preview}\n\n/om:ground needs an interactive session to apply block changes; nothing was written.`);
			return outcome("preview only");
		}
		ctx.ui.notify(preview, "info");
		if (!(await ctx.ui.confirm("Apply grounding to the promoted block?", promoteSummary(plan, ctx.cwd)))) return outcome("declined");
		if (compactionBusy(runtime)) {
			return outcome("not applied: a compaction started meanwhile");
		}
		status.show(`Grounding: writing ${basename(plan.target.contextPath)} and .memory/…`);
		const result = await withConsolidationLock(runtime, notify, async () => {
			const live = ctx.sessionManager.getBranch() as Entry[];
			return applyPromotePlan(plan, live, foldLedger(live), (customType, data) => pi.appendEntry(customType, data), ctx.cwd);
		}, "grounding the block");
		if (!result.ok) return outcome(`not applied: ${result.reason}`);
		// Pi keeps its copy of the file until /reload; the reflector sees OM's content meanwhile.
		runtime.contextFileOverrides.set(plan.target.contextPath, stripBom(plan.newContent));
		debugLog("ground.block_applied", { rewritten: built.rewritten, removed: built.removed, memoryFilesWritten: result.memoryFilesWritten.length, memoryFilesRemoved: result.memoryFilesRemoved.length });
		return outcome(`applied to ${displayPath(plan.target.contextPath, ctx.cwd)}; the main agent sees it after /reload`);
	} finally {
		status.hide();
		runtime.promoteInFlight = false;
	}
}

export function registerGroundCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:ground", {
		description: "Check memory and the promoted AGENTS.md block against the repository, then compact with a full memory fold",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const notify = commandNotify(ctx);

			// Pi's compact() aborts a running turn first.
			if (!ctx.isIdle()) {
				notify("Observational memory: wait until the agent finishes its turn, then run /om:ground again", "warning");
				return;
			}
			if (isBusy(runtime)) {
				notify("Observational memory: a compaction or promotion is already running; try /om:ground again when it finishes", "warning");
				return;
			}
			const target = resolvePromoteTarget(ctx.cwd);
			let parsed: ParsedContextFile;
			try {
				parsed = parseContextFile(readContextFile(target.contextPath) ?? "");
			} catch (error) {
				if (!(error instanceof BlockMarkerError)) throw error;
				notify(`Observational memory: cannot ground: in ${target.contextPath}, ${error.message}; fix them by hand`, "error");
				return;
			}

			// Holding compactInFlight keeps the auto-compaction trigger quiet until this compaction ends.
			runtime.compactInFlight = true;
			if (runtime.consolidationPromise) {
				notify("Observational memory: waiting for running memory workers before grounding", "info");
				await runtime.consolidationPromise.catch(() => undefined);
			}
			refreshProjectContextFromCommand(runtime, ctx);
			const grounding: GroundingRequest = {
				target,
				parsed,
				toolCalls: 0,
				reviewed: false,
				reflectionsRetiredStale: 0,
				reflectionsRewritten: 0,
				blockRevisions: [],
				staleText: [],
			};
			const status = statusWidget(ctx, GROUND_STATUS_WIDGET);
			const progress = groundProgress(status, grounding);
			const request: ReflectRequest = { report: emptyReflectReport(), grounding, onProgress: progress.stage };
			runtime.reflectRequest = request;
			const finish = () => {
				progress.stop();
				if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
				runtime.compactInFlight = false;
			};
			const complete = async () => {
				try {
					const block = await applyBlockRevisions(pi, runtime, ctx, grounding, notify, status);
					notify(renderGroundReport(request.report, grounding, block), "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					debugLog("ground.error", { errorMessage: message });
					notify(`Observational memory: /om:ground failed: ${message}`, "error");
				}
			};
			notify(
				"Observational memory: grounding — checking memory against the repository, then compacting. This can take 5-15 minutes on a large session; the session shows compacting meanwhile and new prompts wait. Esc cancels.",
				"info",
			);

			// Not awaited: compact() reports through these callbacks.
			ctx.compact({
				onComplete: () => {
					finish();
					void complete();
				},
				onError: async (error: Error) => {
					if (!request.report.started && isNothingToCompact(error)) {
						// No cut to fold into, but the pass can still run; it is bounded by groundMaxTurns and the bash timeout.
						if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
						progress.useSpinner();
						try {
							request.report.uncompacted = true;
							await runReflectPass(pi, runtime, ctx, request);
						} catch (passError) {
							finish();
							const message = passError instanceof Error ? passError.message : String(passError);
							notify(`Observational memory: /om:ground failed: ${message}`, "error");
							return;
						}
						finish();
						await complete();
						return;
					}
					finish();
					if (error.message === "Compaction cancelled") {
						notify("Observational memory: /om:ground was cancelled; nothing further was written", "warning");
						return;
					}
					notify(`Observational memory: /om:ground failed: ${error.message}`, "error");
				},
			});
		},
	});
}

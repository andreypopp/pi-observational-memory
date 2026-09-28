import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runReflectPass } from "../hooks/compaction-hook.js";
import { refreshProjectContextFromCommand } from "../hooks/project-context.js";
import {
	emptyReflectReport,
	instructionLine,
	renderGroundReport,
	type GroundingRequest,
	type PassProgressDetail,
	type PassStage,
	type ReflectRequest,
} from "../reflect-report.js";
import { compactionBusy, type Runtime } from "../runtime.js";
import { commandNotify } from "./notify.js";
import { isNothingToCompact, parseInstruction } from "./reflect.js";
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
				text = () => `checking ${reflections} reflection${reflections === 1 ? "" : "s"} against the repo… ${grounding.toolCalls} tool call${grounding.toolCalls === 1 ? "" : "s"},`;
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

export function registerGroundCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:ground", {
		description: "Check memory against the repository, then compact with a full memory fold; optional text is an instruction for the pass",
		handler: async (args, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const notify = commandNotify(ctx);

			// Pi's compact() aborts a running turn first.
			if (!ctx.isIdle()) {
				notify("Observational memory: wait until the agent finishes its turn, then run /om:ground again", "warning");
				return;
			}
			if (compactionBusy(runtime)) {
				notify("Observational memory: a compaction is already running; try /om:ground again when it finishes", "warning");
				return;
			}
			const instruction = parseInstruction(args);

			// Holding compactInFlight keeps the auto-compaction trigger quiet until this compaction ends.
			runtime.compactInFlight = true;
			if (runtime.consolidationPromise) {
				notify("Observational memory: waiting for running memory workers before grounding", "info");
				await runtime.consolidationPromise.catch(() => undefined);
			}
			refreshProjectContextFromCommand(runtime, ctx);
			const grounding: GroundingRequest = {
				toolCalls: 0,
				reviewed: false,
				reflectionsRetiredStale: 0,
				reflectionsRewritten: 0,
				staleText: [],
			};
			const progress = groundProgress(statusWidget(ctx, GROUND_STATUS_WIDGET), grounding);
			const request: ReflectRequest = { report: emptyReflectReport(), ...(instruction ? { instruction } : {}), grounding, onProgress: progress.stage };
			runtime.reflectRequest = request;
			const finish = () => {
				progress.stop();
				if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
				runtime.compactInFlight = false;
			};
			const complete = () => notify(renderGroundReport(request.report, grounding, instruction), "info");
			notify(
				[
					"Observational memory: grounding — checking memory against the repository, then compacting. This can take 5-15 minutes on a large session; the session shows compacting meanwhile and new prompts wait. Esc cancels.",
					...instructionLine(instruction),
				].join("\n"),
				"info",
			);

			// Not awaited: compact() reports through these callbacks.
			ctx.compact({
				onComplete: () => {
					finish();
					complete();
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
						complete();
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

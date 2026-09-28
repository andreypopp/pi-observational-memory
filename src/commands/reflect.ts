import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runReflectPass } from "../hooks/compaction-hook.js";
import { refreshProjectContextFromCommand } from "../hooks/project-context.js";
import { compactionBusy, type Runtime } from "../runtime.js";
import { emptyReflectReport, instructionLine, renderReflectReport, type ReflectRequest } from "../reflect-report.js";
import { commandNotify } from "./notify.js";

/** A command's arguments as the pass's instruction: trimmed, undefined when blank. */
export function parseInstruction(args: string | undefined): string | undefined {
	return args?.trim() || undefined;
}

/** Pi's rejections when the branch has no removable range; they come before any compaction hook runs. */
export function isNothingToCompact(error: Error): boolean {
	return error.message.startsWith("Nothing to compact") || error.message === "Already compacted";
}

export function registerReflectCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:reflect", {
		description: "Run all memory workers now, then compact with a full memory fold when there is something to compact; optional text is an instruction for the pass",
		handler: async (args, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const notify = commandNotify(ctx);

			// Pi's compact() aborts a running turn first.
			if (!ctx.isIdle()) {
				notify("Observational memory: wait until the agent finishes its turn, then run /om:reflect again", "warning");
				return;
			}
			if (compactionBusy(runtime)) {
				notify("Observational memory: a compaction is already running; try /om:reflect again when it finishes", "warning");
				return;
			}
			const instruction = parseInstruction(args);

			// Holding compactInFlight keeps the auto-compaction trigger quiet until this compaction ends.
			runtime.compactInFlight = true;
			if (runtime.consolidationPromise) {
				notify("Observational memory: waiting for running memory workers before reflecting", "info");
				await runtime.consolidationPromise.catch(() => undefined);
			}

			// The forced pass reviews every reflection, so give it the session's current context files.
			refreshProjectContextFromCommand(runtime, ctx);
			const request: ReflectRequest = { report: emptyReflectReport(), ...(instruction ? { instruction } : {}) };
			runtime.reflectRequest = request;
			const finish = () => {
				if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
				runtime.compactInFlight = false;
			};
			notify(["Observational memory: reflecting — running memory workers, then compacting", ...instructionLine(instruction)].join("\n"), "info");

			// Not awaited: compact() reports through these callbacks.
			ctx.compact({
				onComplete: () => {
					finish();
					notify(renderReflectReport(request.report, instruction), "info");
				},
				onError: async (error: Error) => {
					if (!request.report.started && isNothingToCompact(error)) {
						// No cut to fold into, but the workers can still run; compactInFlight stays held meanwhile.
						if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
						try {
							request.report.uncompacted = true;
							await runReflectPass(pi, runtime, ctx, request);
							notify(renderReflectReport(request.report, instruction), "info");
						} catch (passError) {
							const message = passError instanceof Error ? passError.message : String(passError);
							notify(`Observational memory: /om:reflect failed: ${message}`, "error");
						} finally {
							finish();
						}
						return;
					}
					finish();
					if (error.message === "Compaction cancelled") {
						notify("Observational memory: /om:reflect compaction was cancelled", "warning");
						return;
					}
					notify(`Observational memory: /om:reflect failed: ${error.message}`, "error");
				},
			});
		},
	});
}

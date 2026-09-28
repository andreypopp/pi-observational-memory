import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runReflectPass } from "../hooks/compaction-hook.js";
import { refreshProjectContextFromCommand } from "../hooks/project-context.js";
import type { Runtime } from "../runtime.js";
import { emptyReflectReport, renderReflectReport, type ReflectRequest } from "../reflect-report.js";

type NotifyLevel = "info" | "warning" | "error";

/** Pi's rejections when the branch has no removable range; they come before any compaction hook runs. */
function isNothingToCompact(error: Error): boolean {
	return error.message.startsWith("Nothing to compact") || error.message === "Already compacted";
}

export function registerReflectCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:reflect", {
		description: "Run all memory workers now, then compact with a full memory fold when there is something to compact",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const hasUI = ctx.hasUI;
			const ui = ctx.ui;
			const notify = (message: string, level: NotifyLevel = "info") => {
				if (hasUI && ui) ui.notify(message, level);
				else console.log(message);
			};

			if (runtime.compactInFlight || runtime.compactHookInFlight || runtime.reflectRequest) {
				notify("Observational memory: a compaction is already running; try /om:reflect again when it finishes", "warning");
				return;
			}

			// Holding compactInFlight keeps the auto-compaction trigger quiet until this compaction ends.
			runtime.compactInFlight = true;
			if (runtime.consolidationPromise) {
				notify("Observational memory: waiting for running memory workers before reflecting", "info");
				await runtime.consolidationPromise.catch(() => undefined);
			}

			// The forced pass reviews every reflection, so give it the session's current context files.
			refreshProjectContextFromCommand(runtime, ctx);
			const request: ReflectRequest = { report: emptyReflectReport() };
			runtime.reflectRequest = request;
			const finish = () => {
				if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
				runtime.compactInFlight = false;
			};
			notify("Observational memory: reflecting — running memory workers, then compacting", "info");

			// Not awaited: Pi's compact() waits for the session to go idle first.
			ctx.compact({
				onComplete: () => {
					finish();
					notify(renderReflectReport(request.report), "info");
				},
				onError: async (error: Error) => {
					if (!request.report.started && isNothingToCompact(error)) {
						// No cut to fold into, but the workers can still run; compactInFlight stays held meanwhile.
						if (runtime.reflectRequest === request) runtime.reflectRequest = undefined;
						try {
							request.report.uncompacted = true;
							await runReflectPass(pi, runtime, ctx, request);
							notify(renderReflectReport(request.report), "info");
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

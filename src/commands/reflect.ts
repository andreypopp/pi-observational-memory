import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshProjectContextFromCommand } from "../hooks/project-context.js";
import type { Runtime } from "../runtime.js";
import { emptyReflectReport, renderReflectReport, type ReflectRequest } from "../reflect-report.js";

type NotifyLevel = "info" | "warning" | "error";

export function registerReflectCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:reflect", {
		description: "Run all memory workers now, then compact with a full memory fold",
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
				onError: (error: Error) => {
					finish();
					if (error.message === "Compaction cancelled") {
						notify("Observational memory: /om:reflect compaction was cancelled", "warning");
						return;
					}
					if (!request.report.started) {
						// Pi rejected before the hook ran ("Nothing to compact", "Already compacted").
						notify("Observational memory: nothing to compact yet; /om:reflect needs more conversation since the last compaction", "info");
						return;
					}
					notify(`Observational memory: /om:reflect failed: ${error.message}`, "error");
				},
			});
		},
	});
}

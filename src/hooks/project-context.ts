import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProjectContextFile, type ProjectContextFile } from "../agents/project-context.js";
import { debugLog } from "../debug-log.js";
import type { Runtime } from "../runtime.js";

/** Where the reflector's context files came from: "none" when the feature is off or nothing could be read. */
export type ProjectContextSource = "snapshot" | "command" | "loader" | "none";

export type ResolvedProjectContextFiles = { files: ProjectContextFile[]; source: ProjectContextSource };

type ContextFileLoader = (options: { cwd: string; agentDir: string }) => unknown;

/** Store context files Pi reported; ignored unless they arrive as an array. */
export function captureProjectContextFiles(runtime: Runtime, files: unknown, source: "snapshot" | "command"): void {
	if (!Array.isArray(files)) return;
	runtime.projectContext = { files: files.filter(isProjectContextFile).map(({ path, content }) => ({ path, content })), source };
}

/**
 * Snapshot the session's context files from `before_agent_start`, which carries what Pi puts in the
 * main agent's system prompt (honouring --no-context-files). Observe only: returns nothing.
 */
export function registerProjectContextSnapshot(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("before_agent_start", (event) => {
		captureProjectContextFiles(runtime, event.systemPromptOptions?.contextFiles, "snapshot");
	});
}

/**
 * Refresh from a command context. Guarded: a host without `getSystemPromptOptions` would otherwise
 * report empty options and clobber a good snapshot.
 */
export function refreshProjectContextFromCommand(runtime: Runtime, ctx: { getSystemPromptOptions?: unknown }): void {
	if (typeof ctx.getSystemPromptOptions !== "function") return;
	try {
		const options = (ctx.getSystemPromptOptions as () => { contextFiles?: unknown } | undefined)();
		captureProjectContextFiles(runtime, options?.contextFiles, "command");
	} catch (error) {
		debugLog("project_context.command_error", { errorMessage: error instanceof Error ? error.message : String(error) });
	}
}

/** Pi's own context-file loader, when the host exports it. */
function piContextFileLoader(): ContextFileLoader | undefined {
	const loader = (piCodingAgent as { loadProjectContextFiles?: unknown }).loadProjectContextFiles;
	return typeof loader === "function" ? (loader as ContextFileLoader) : undefined;
}

/**
 * The context files the reflector should see. Prefers the latest snapshot or command refresh; without
 * one (a fresh Runtime after /reload, or a run started by `triggerTurn`, which skips before_agent_start)
 * it loads them the way Pi's resource loader does.
 */
export function resolveProjectContextFiles(runtime: Runtime, cwd: string): ResolvedProjectContextFiles {
	if (runtime.config.projectContext === false) return { files: [], source: "none" };
	if (runtime.projectContext) return runtime.projectContext;
	const loader = piContextFileLoader();
	if (!loader) return { files: [], source: "none" };
	try {
		const files = loader({ cwd, agentDir: piCodingAgent.getAgentDir() });
		if (!Array.isArray(files)) return { files: [], source: "none" };
		return { files: files.filter(isProjectContextFile), source: "loader" };
	} catch (error) {
		debugLog("project_context.loader_error", { errorMessage: error instanceof Error ? error.message : String(error) });
		return { files: [], source: "none" };
	}
}

import { basename } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProjectContextFile, type ProjectContextFile } from "../agents/project-context.js";
import { debugLog } from "../debug-log.js";
import { MEMORY_FILE_NAME, parsePromotedMemory, readPromotedMemory } from "../project-memory/memory-file.js";
import { resolvePromoteTarget, type PromoteTarget } from "../project-memory/target.js";
import type { Runtime } from "../runtime.js";

/** Where the reflector's context files came from: "none" when the feature is off or nothing could be read. */
export type ProjectContextSource = "snapshot" | "command" | "loader" | "none";

export type ResolvedProjectContextFiles = { files: ProjectContextFile[]; source: ProjectContextSource };

type ContextFileLoader = (options: { cwd: string; agentDir: string }) => unknown;

/**
 * Store context files Pi reported; ignored unless they arrive as an array. `.memory.md` is left out:
 * {@link resolveProjectContextFiles} reads it fresh. Matched by name, not path: a command refresh has no cwd
 * to resolve the target from; everywhere else the file is matched by its resolved path.
 */
export function captureProjectContextFiles(runtime: Runtime, files: unknown, source: "snapshot" | "command"): void {
	if (!Array.isArray(files)) return;
	runtime.projectContext = {
		files: files.filter(isProjectContextFile).filter((file) => basename(file.path) !== MEMORY_FILE_NAME).map(({ path, content }) => ({ path, content })),
		source,
	};
}

/**
 * Whether promoted memory reaches the main agent and the workers: off with `promotedMemory: false` or
 * when Pi runs with --no-context-files. SDK hosts that disable context files are not detected.
 */
export function promotedMemoryEnabled(runtime: Runtime, argv: readonly string[] = process.argv): boolean {
	return runtime.config.promotedMemory !== false && !argv.some((arg) => arg === "--no-context-files" || arg === "-nc");
}

/**
 * `.memory.md` as a context file, read fresh from disk; undefined when promoted memory is off, or the file is
 * missing, unreadable or has no lines.
 */
export function promotedMemoryContextFile(runtime: Runtime, cwd: string): ProjectContextFile | undefined {
	if (!promotedMemoryEnabled(runtime)) return undefined;
	const { memoryPath } = resolvePromoteTarget(cwd);
	let raw: string | undefined;
	try {
		raw = readPromotedMemory(memoryPath);
	} catch {
		return undefined;
	}
	if (raw === undefined) return undefined;
	const content = stripBom(raw).trimEnd();
	return parsePromotedMemory(content).lines.length > 0 ? { path: memoryPath, content } : undefined;
}

/**
 * On `before_agent_start`: add `.memory.md` to the main agent's context files (read fresh, so a promote
 * reaches the next prompt), then snapshot the context files Pi puts in its system prompt (honouring
 * --no-context-files). Edits the event's options in place and returns nothing.
 */
export function registerProjectContextSnapshot(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("before_agent_start", (event, ctx) => {
		const contextFiles = event.systemPromptOptions?.contextFiles;
		if (Array.isArray(contextFiles)) {
			try {
				const cwd = ctx?.cwd ?? event.systemPromptOptions.cwd ?? process.cwd();
				runtime.ensureConfig(cwd);
				const memory = promotedMemoryContextFile(runtime, cwd);
				if (memory && !contextFiles.some((file) => file?.path === memory.path)) contextFiles.push(memory);
			} catch (error) {
				debugLog("project_context.memory_file_error", { errorMessage: error instanceof Error ? error.message : String(error) });
			}
		}
		captureProjectContextFiles(runtime, contextFiles, "snapshot");
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
 * it loads them the way Pi's resource loader does. `.memory.md`, read fresh, comes last.
 */
export function resolveProjectContextFiles(runtime: Runtime, cwd: string): ResolvedProjectContextFiles {
	if (runtime.config.projectContext === false) return { files: [], source: "none" };
	const resolved = loadProjectContextFiles(runtime, cwd);
	const memory = promotedMemoryContextFile(runtime, cwd);
	if (!memory) return resolved;
	return { files: [...resolved.files.filter((file) => file.path !== memory.path), memory], source: resolved.source };
}

function loadProjectContextFiles(runtime: Runtime, cwd: string): ResolvedProjectContextFiles {
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

export function stripBom(content: string): string {
	return content.replace(/^\uFEFF/, "");
}

/** The resolved context files without `.memory.md`, whose lines /om:promote and /om:ground show in their own section. */
export function contextFilesWithoutMemoryFile(files: ProjectContextFile[], target: PromoteTarget): ProjectContextFile[] {
	return files.filter((file) => file.path !== target.memoryPath);
}

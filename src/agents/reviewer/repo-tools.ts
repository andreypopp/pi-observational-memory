import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";

/** Environment for grounding bash calls: no pagers, no prompts, no optional git locks. */
export const GROUNDING_BASH_ENV: Readonly<Record<string, string>> = {
	GIT_PAGER: "cat",
	PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	CI: "1",
	GIT_OPTIONAL_LOCKS: "0",
};

export const GROUNDING_BASH_DEFAULT_TIMEOUT_SECONDS = 60;
export const GROUNDING_BASH_MAX_TIMEOUT_SECONDS = 120;

/** The model's timeout in seconds, defaulted and capped so no grounding command runs unbounded. */
export function groundingBashTimeout(timeout: unknown): number {
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return GROUNDING_BASH_DEFAULT_TIMEOUT_SECONDS;
	return Math.min(timeout, GROUNDING_BASH_MAX_TIMEOUT_SECONDS);
}

/** Pi's bash tool with every call bounded by {@link groundingBashTimeout}. */
type BashTool = ReturnType<typeof createBashTool>;

function boundedBash(bash: BashTool): BashTool {
	return {
		...bash,
		description: `${bash.description} Here every command times out after ${GROUNDING_BASH_DEFAULT_TIMEOUT_SECONDS} seconds unless you give a timeout (at most ${GROUNDING_BASH_MAX_TIMEOUT_SECONDS}).`,
		execute: (toolCallId, params, signal, onUpdate) =>
			bash.execute(toolCallId, { ...params, timeout: groundingBashTimeout(params.timeout) }, signal, onUpdate),
	};
}

/**
 * Pi's read, grep, find, ls and bash tools rooted at `root`, for /om:ground's review. Nothing but the
 * prompt keeps bash read-only; its runs are bounded in time and get a non-interactive environment.
 */
export function createRepoTools(root: string): AgentTool<any>[] {
	const bash = createBashTool(root, {
		exposeSessionEnvironment: false,
		spawnHook: (context) => ({ ...context, env: { ...context.env, ...GROUNDING_BASH_ENV } }),
	});
	return [
		createReadTool(root),
		createGrepTool(root),
		createFindTool(root),
		createLsTool(root),
		boundedBash(bash),
	] as AgentTool<any>[];
}

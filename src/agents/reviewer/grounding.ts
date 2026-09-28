import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";

/** Hand-written context-file text the repository contradicts; reported, never edited. */
export type StaleTextReport = { path: string; excerpt: string; reason: string };

export type GroundingReviewArgs = {
	/** Read-only repo tools rooted at the session's directory. */
	tools: AgentTool<any>[];
	/** The directory the tools run in. */
	root: string;
	/** Called with the running count after each repo tool call starts. */
	onToolCall?: (count: number) => void;
};

export type GroundingReviewResult = {
	toolCalls: number;
	staleText: StaleTextReport[];
};

const ReportItemSchema = Type.Object({
	path: Type.String({ description: "Context file holding the hand-written text." }),
	excerpt: Type.String({ description: "A short excerpt of the stale text." }),
	reason: Type.String({ description: "The evidence that contradicts it." }),
});

const ReportStaleSchema = Type.Object({
	report: Type.Array(ReportItemSchema),
});

type ReportStaleArgs = Static<typeof ReportStaleSchema>;

/** The `report_stale_instructions` tool: collects reports of stale hand-written text. Nothing is ever edited. */
export function createReportStaleTool(): { tool: AgentTool<typeof ReportStaleSchema>; result: () => StaleTextReport[] } {
	const staleText: StaleTextReport[] = [];
	const tool: AgentTool<typeof ReportStaleSchema> = {
		name: "report_stale_instructions",
		label: "Report stale instructions",
		description: "Report hand-written context-file text the repository contradicts. It is listed for the user, never edited.",
		parameters: ReportStaleSchema,
		execute: async (_id, params: ReportStaleArgs) => {
			const problems: string[] = [];
			let reported = 0;
			for (const item of params.report) {
				const entry = { path: item.path.trim(), excerpt: item.excerpt.trim(), reason: item.reason.trim() };
				if (!entry.path || !entry.excerpt || !entry.reason) {
					problems.push("report items need a path, an excerpt and a reason");
					continue;
				}
				staleText.push(entry);
				reported++;
			}
			const text = `Recorded ${reported} report${reported === 1 ? "" : "s"}.${problems.length > 0 ? ` Problems: ${problems.join("; ")}` : ""}`;
			return { content: [{ type: "text", text }], details: { reported, problems: problems.length } };
		},
	};
	return { tool, result: () => staleText };
}

const LOGGED_ARGS_CHARS = 2000;

/** Wrap repo tools so each call counts, reports the running total, and logs what it ran. */
export function countedTools(tools: readonly AgentTool<any>[], onCall: () => void): AgentTool<any>[] {
	return tools.map((tool) => ({
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => {
			onCall();
			debugLog("reflector.grounding_tool_call", { tool: tool.name, args: JSON.stringify(params).slice(0, LOGGED_ARGS_CHARS) });
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	}));
}

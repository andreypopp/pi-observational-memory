import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { promotedLineTokens, renderPromotedLine, type PromotedLine } from "../../project-memory/memory-file.js";
import type { PromoteSourceRecord } from "../promoter/agent.js";
import { normalizeContent } from "../worker-format.js";

/** What /om:ground's review decided for one promoted block line. */
export type PromotedLineRevision =
	| { id: string; action: "rewrite"; content: string; reason: string }
	| { id: string; action: "remove"; reason: string };

/** Hand-written context-file text the repository contradicts; reported, never edited. */
export type StaleTextReport = { path: string; excerpt: string; reason: string };

export type GroundingReviewArgs = {
	/** Read-only repo tools rooted at the project root. */
	tools: AgentTool<any>[];
	/** The project root the tools run in. */
	root: string;
	/** `.memory.md`, holding the promoted lines; labels their section. */
	memoryPath: string;
	/** The promoted block's lines as read for this pass. */
	promotedLines: PromotedLine[];
	/** Reflection records behind block line ids; a rewrite carries their evidence. */
	lineRecords: ReadonlyMap<string, PromoteSourceRecord>;
	maxPromotedTokens: number;
	/** Called with the running count after each repo tool call starts. */
	onToolCall?: (count: number) => void;
};

export type GroundingReviewResult = {
	toolCalls: number;
	/** Block line decisions, in block order. */
	lineRevisions: PromotedLineRevision[];
	staleText: StaleTextReport[];
};

const ReviseItemSchema = Type.Object({
	id: Type.String({ description: "Id of a promoted block line." }),
	action: Type.Union([Type.Literal("rewrite"), Type.Literal("remove")]),
	content: Type.Optional(Type.String({ description: "The rewritten line (single line); only for rewrite." })),
	reason: Type.String({ description: "The evidence: file:line, or the command and its relevant output." }),
});

const ReportItemSchema = Type.Object({
	path: Type.String({ description: "Context file holding the hand-written text." }),
	excerpt: Type.String({ description: "A short excerpt of the stale text." }),
	reason: Type.String({ description: "The evidence that contradicts it." }),
});

const ReviseBlockSchema = Type.Object({
	revise: Type.Optional(Type.Array(ReviseItemSchema)),
	report: Type.Optional(Type.Array(ReportItemSchema)),
});

type ReviseBlockArgs = Static<typeof ReviseBlockSchema>;

/**
 * The `revise_promoted_block` tool: collects rewrites and removals of block lines, validated like
 * `set_promoted_block` (known ids, single-line content, fresh ids, the block budget), plus reports of
 * stale hand-written text. Nothing is written here; /om:ground applies the collected decisions later.
 */
export function createReviseBlockTool(args: {
	promotedLines: readonly PromotedLine[];
	lineRecords: ReadonlyMap<string, PromoteSourceRecord>;
	activeReflectionIds: ReadonlySet<string>;
	retiredReflectionIds: ReadonlySet<string>;
	maxPromotedTokens: number;
}): { tool: AgentTool<typeof ReviseBlockSchema>; result: () => Pick<GroundingReviewResult, "lineRevisions" | "staleText"> } {
	const lineById = new Map(args.promotedLines.map((line) => [line.id, line]));
	const revisions = new Map<string, PromotedLineRevision>();
	const staleText: StaleTextReport[] = [];
	const currentTokens = promotedLineTokens(args.promotedLines.map((line) => line.raw.trim()));

	const linesWith = (candidate: ReadonlyMap<string, PromotedLineRevision>) => args.promotedLines.flatMap((line) => {
		const revision = candidate.get(line.id);
		if (!revision) return [line.raw.trim()];
		return revision.action === "remove" ? [] : [renderPromotedLine(hashId(revision.content), revision.content)];
	});

	const tool: AgentTool<typeof ReviseBlockSchema> = {
		name: "revise_promoted_block",
		label: "Revise promoted block",
		description: "Rewrite or remove promoted block lines the repository contradicts, and report stale hand-written context-file text. Unmentioned lines are kept; nothing is written until the user confirms.",
		parameters: ReviseBlockSchema,
		execute: async (_id, params: ReviseBlockArgs) => {
			const problems: string[] = [];
			const accepted = new Map<string, PromotedLineRevision>();
			const newIds = new Set(Array.from(revisions.values()).flatMap((revision) => revision.action === "rewrite" ? [hashId(revision.content)] : []));

			for (const item of params.revise ?? []) {
				const reason = item.reason.trim();
				if (!lineById.has(item.id)) {
					problems.push(`${item.id} is not a promoted block line`);
					continue;
				}
				if (revisions.has(item.id) || accepted.has(item.id)) {
					problems.push(`${item.id} was already decided`);
					continue;
				}
				if (!reason) {
					problems.push(`${item.id}: give the evidence as reason`);
					continue;
				}
				if (item.action === "remove") {
					accepted.set(item.id, { id: item.id, action: "remove", reason });
					continue;
				}
				const content = item.content === undefined ? undefined : normalizeContent(item.content);
				if (!content) {
					problems.push(`${item.id}: content must be a non-empty single line`);
					continue;
				}
				if (!args.lineRecords.has(item.id)) {
					problems.push(`${item.id} has no recorded evidence to carry forward; remove it or leave it`);
					continue;
				}
				const newId = hashId(content);
				if (newId === item.id || args.retiredReflectionIds.has(newId)) {
					problems.push(`${item.id}: its content matches the line itself or a retired reflection; reword it`);
					continue;
				}
				if (lineById.has(newId) || args.activeReflectionIds.has(newId) || newIds.has(newId)) {
					problems.push(`${item.id}: its content matches ${newId}, which already exists; remove the line instead`);
					continue;
				}
				newIds.add(newId);
				accepted.set(item.id, { id: item.id, action: "rewrite", content, reason });
			}

			if (accepted.size > 0) {
				const candidate = new Map([...revisions, ...accepted]);
				const tokens = promotedLineTokens(linesWith(candidate));
				if (tokens > args.maxPromotedTokens && tokens > currentTokens) {
					problems.push(`the block would use ~${tokens} tokens, over the budget of ${args.maxPromotedTokens}; shorten the rewrites`);
					accepted.clear();
				}
			}
			for (const [id, revision] of accepted) revisions.set(id, revision);

			let reported = 0;
			for (const item of params.report ?? []) {
				const entry = { path: item.path.trim(), excerpt: item.excerpt.trim(), reason: item.reason.trim() };
				if (!entry.path || !entry.excerpt || !entry.reason) {
					problems.push("report items need a path, an excerpt and a reason");
					continue;
				}
				staleText.push(entry);
				reported++;
			}

			const text = `Recorded ${accepted.size} line decision${accepted.size === 1 ? "" : "s"} and ${reported} report${reported === 1 ? "" : "s"}.${problems.length > 0 ? ` Problems: ${problems.join("; ")}` : ""}`;
			return { content: [{ type: "text", text }], details: { accepted: accepted.size, reported, problems: problems.length } };
		},
	};

	return {
		tool,
		result: () => ({
			lineRevisions: args.promotedLines.flatMap((line) => revisions.get(line.id) ?? []),
			staleText,
		}),
	};
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

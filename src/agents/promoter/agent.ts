import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { blockTokens, renderBlockLine, type BlockLine } from "../../project-memory/memory-file.js";
import type { Reflection } from "../../session-ledger/index.js";
import { withProjectContext } from "../project-context.js";
import { reflectionToReviewLine } from "../reviewer/agent.js";
import { logAgentStreamError } from "../stream-errors.js";
import { joinOrEmpty, normalizeContent } from "../worker-format.js";
import { workerMessages } from "../worker-prompt.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { PROMOTE_SYSTEM } from "./prompts.js";

/** What a block line id resolves to, for lines whose evidence a rewrite can carry forward. */
export type PromoteSourceRecord = Pick<Reflection, "id" | "content" | "supportingObservationIds">;

interface RunPromoterArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Current lines of `.memory.md`. */
	blockLines: BlockLine[];
	/** Reflection records behind block line ids (branch ledger or `.memory/`), when known. */
	blockRecords: ReadonlyMap<string, PromoteSourceRecord>;
	activeReflections: Reflection[];
	/** Display record time ("YYYY-MM-DD HH:MM") per reflection id. */
	recordedAt: ReadonlyMap<string, string>;
	/** Retired reflection ids; a rewritten line must not reuse one. */
	retiredReflectionIds: ReadonlySet<string>;
	/** Rendered PROJECT INSTRUCTIONS block without `.memory.md`; "" or absent leaves it out. */
	projectContext?: string;
	maxBlockTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

export type ProposedBlockLine =
	| { kind: "keep"; id: string; line: string }
	/** An active reflection promoted unchanged: the line keeps the reflection's id. */
	| { kind: "promote"; id: string; line: string; reflection: Reflection }
	/** A new line written from reflections and/or block lines. */
	| {
			kind: "rewrite";
			id: string;
			line: string;
			content: string;
			fromIds: string[];
			/** fromIds backed by a reflection record. */
			replaces: string[];
			supportingObservationIds: string[];
	  };

export type PromoterResult = { lines: ProposedBlockLine[]; tokens: number };

const LineSchema = Type.Object({
	keepId: Type.Optional(Type.String({ description: "Id of an existing block line to keep unchanged." })),
	content: Type.Optional(Type.String({ description: "Text of a new line (single line)." })),
	fromIds: Type.Optional(Type.Array(Type.String(), { description: "Active reflection ids and/or existing block line ids this line is written from." })),
});

const SetPromotedBlockSchema = Type.Object({
	lines: Type.Array(LineSchema),
});

type SetPromotedBlockArgs = Static<typeof SetPromotedBlockSchema>;

/** Validate one proposed block; returns the lines or the problems found. */
export function validatePromotedBlock(
	params: SetPromotedBlockArgs,
	args: Pick<RunPromoterArgs, "blockLines" | "blockRecords" | "activeReflections" | "retiredReflectionIds" | "maxBlockTokens">,
): { lines: ProposedBlockLine[]; tokens: number } | { problems: string[] } {
	const blockById = new Map(args.blockLines.map((line) => [line.id, line]));
	const activeById = new Map(args.activeReflections.map((reflection) => [reflection.id, reflection]));
	const problems: string[] = [];
	const usedIds = new Set<string>();
	const lineIds = new Set<string>();
	const lines: ProposedBlockLine[] = [];

	const useId = (id: string, where: string): boolean => {
		if (usedIds.has(id)) {
			problems.push(`${where}: ${id} is used more than once`);
			return false;
		}
		usedIds.add(id);
		return true;
	};
	const addLine = (line: ProposedBlockLine, where: string) => {
		if (lineIds.has(line.id)) {
			problems.push(`${where}: another line already has id ${line.id}`);
			return;
		}
		lineIds.add(line.id);
		lines.push(line);
	};

	params.lines.forEach((item, index) => {
		const where = `line ${index + 1}`;
		if (item.keepId !== undefined) {
			if (item.content !== undefined || item.fromIds !== undefined) {
				problems.push(`${where}: give either keepId or content with fromIds, not both`);
				return;
			}
			const kept = blockById.get(item.keepId);
			if (!kept) {
				problems.push(`${where}: ${item.keepId} is not an existing block line`);
				return;
			}
			if (useId(kept.id, where)) addLine({ kind: "keep", id: kept.id, line: kept.raw.trim() }, where);
			return;
		}
		const content = item.content === undefined ? undefined : normalizeContent(item.content);
		if (!content) {
			problems.push(`${where}: content must be a non-empty single line`);
			return;
		}
		const fromIds = Array.from(new Set(item.fromIds ?? []));
		if (fromIds.length === 0) {
			problems.push(`${where}: fromIds must name the reflections or block lines it is written from`);
			return;
		}
		const unknown = fromIds.filter((id) => !activeById.has(id) && !blockById.has(id));
		if (unknown.length > 0) {
			problems.push(`${where}: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an active reflection or block line`);
			return;
		}
		if (!fromIds.every((id) => useId(id, where))) return;

		if (fromIds.length === 1) {
			const [sourceId] = fromIds;
			const reflection = activeById.get(sourceId);
			if (reflection && reflection.content === content) {
				addLine({ kind: "promote", id: reflection.id, line: renderBlockLine(reflection.id, content), reflection }, where);
				return;
			}
			const blockLine = blockById.get(sourceId);
			if (blockLine && blockLine.content === content) {
				addLine({ kind: "keep", id: blockLine.id, line: blockLine.raw.trim() }, where);
				return;
			}
		}

		const id = hashId(content);
		if (args.retiredReflectionIds.has(id) || fromIds.includes(id)) {
			problems.push(`${where}: its content matches a retired or replaced reflection; reword it`);
			return;
		}
		if (activeById.has(id) || blockById.has(id)) {
			problems.push(`${where}: its content matches ${id}, which is not in its fromIds; use that id instead`);
			return;
		}
		const sources = fromIds.flatMap((sourceId) => {
			const record = activeById.get(sourceId) ?? args.blockRecords.get(sourceId);
			return record ? [record] : [];
		});
		const supportingObservationIds = Array.from(new Set(sources.flatMap((source) => source.supportingObservationIds)));
		if (supportingObservationIds.length === 0) {
			problems.push(`${where}: none of its fromIds has recorded evidence; keep hand-written lines with keepId instead of rewording them`);
			return;
		}
		addLine({
			kind: "rewrite",
			id,
			line: renderBlockLine(id, content),
			content,
			fromIds,
			replaces: sources.map((source) => source.id),
			supportingObservationIds,
		}, where);
	});

	if (problems.length > 0) return { problems };
	const tokens = blockTokens(lines.map((line) => line.line));
	if (tokens > args.maxBlockTokens) {
		return { problems: [`the block would use ~${tokens} tokens, over the budget of ${args.maxBlockTokens}; shorten, merge or drop lines`] };
	}
	return { lines, tokens };
}

/**
 * Ask the model for the new promoted block. Returns the last accepted proposal, or undefined when the
 * model left the block as it is.
 */
export async function runPromoter(args: RunPromoterArgs): Promise<PromoterResult | undefined> {
	const { model, apiKey, headers, env, signal } = args;
	let accepted: PromoterResult | undefined;
	let toolCallCount = 0;
	let rejectedCount = 0;

	const setPromotedBlock: AgentTool<typeof SetPromotedBlockSchema> = {
		name: "set_promoted_block",
		label: "Set promoted block",
		description: "Submit the complete new promoted-memory block, lines in order. Replaces any earlier submission.",
		parameters: SetPromotedBlockSchema,
		execute: async (_id, params: SetPromotedBlockArgs) => {
			toolCallCount++;
			const result = validatePromotedBlock(params, args);
			if ("problems" in result) {
				rejectedCount++;
				return {
					content: [{ type: "text", text: `Rejected, nothing recorded. Problems: ${result.problems.join("; ")}` }],
					details: { accepted: false, problems: result.problems.length },
				};
			}
			accepted = result;
			return {
				content: [{ type: "text", text: `Accepted: ${result.lines.length} lines, ~${result.tokens} of ${args.maxBlockTokens} tokens.` }],
				details: { accepted: true, lines: result.lines.length, tokens: result.tokens },
			};
		},
	};

	const blockText = args.blockLines.map((line) => `[${line.id}] ${line.content}`);
	const reflectionLines = args.activeReflections.map((reflection) => reflectionToReviewLine(reflection, args.recordedAt.get(reflection.id), false));
	const currentTokens = blockTokens(args.blockLines.map((line) => line.raw.trim()));
	const userText = withProjectContext(
		args.projectContext,
		`PROMOTED BLOCK:\n${joinOrEmpty(blockText)}\n\nACTIVE REFLECTIONS:\n${joinOrEmpty(reflectionLines)}\n\nBLOCK BUDGET: ${args.maxBlockTokens} estimated tokens for the whole block (the current block uses ~${currentTokens}).\n\nSubmit the new block, or do not call the tool if it should stay as it is.`,
	);
	const { system, prompts } = workerMessages(model, PROMOTE_SYSTEM, userText);
	const context: AgentContext = { messages: system, tools: [setPromotedBlock as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					return ++turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple));
	let streamError: string | undefined;
	for await (const event of stream) {
		logAgentStreamError("promote", event);
		if (event.type === "message_end" && event.message.role === "assistant") {
			streamError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
				? event.message.errorMessage ?? event.message.stopReason
				: undefined;
		}
	}
	await stream.result();

	debugLog("promote.result", {
		toolCallCount,
		rejectedCount,
		accepted: accepted !== undefined,
		lineCount: accepted?.lines.length ?? 0,
		tokens: accepted?.tokens ?? 0,
	});
	// A failed call is not "leave the block as it is": throw so the caller can retry on the fallback model.
	if (!accepted && streamError) throw new Error(streamError);
	return accepted;
}

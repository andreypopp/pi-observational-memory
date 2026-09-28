import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { logAgentStreamError } from "../stream-errors.js";
import { withProjectContext } from "../project-context.js";
import { joinOrEmpty, normalizeContent } from "../worker-format.js";
import { workerMessages } from "../worker-prompt.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { estimateStringTokens } from "../../tokens.js";
import {
	isReflectionRetirementKind,
	observationToSummaryLine,
	type Observation,
	type Reflection,
	type ReflectionRetirementKind,
} from "../../session-ledger/index.js";
import { REVIEW_SYSTEM } from "./prompts.js";

interface RunReflectionReviewArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Active reflections under review. */
	reflections: Reflection[];
	/** Reflections recorded in this pass: they may be replaced, and retired outright only as covered by project instructions. */
	newReflectionIds: ReadonlySet<string>;
	/** Already retired ids; a replacement must not reuse one. */
	retiredReflectionIds: ReadonlySet<string>;
	/** Display record time ("YYYY-MM-DD HH:MM") per reflection id. */
	recordedAt: ReadonlyMap<string, string>;
	observations: Observation[];
	/** Rendered PROJECT INSTRUCTIONS block, prepended to the user message; "" or absent leaves it unchanged. */
	projectContext?: string;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	/** Maximum output tokens for the loop (defaults to {@link AGENT_LOOP_MAX_TOKENS}). */
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

export type ReflectionRetirement = {
	reflectionIds: string[];
	replacedBy?: string;
	/** Why plain retirements were made; absent on replacements. */
	kind?: ReflectionRetirementKind;
};

export type ReflectionReviewResult = {
	/** New reflections to record, each carrying the ids it replaces. */
	replacements: Reflection[];
	/** One group per replacement target, then one group of plain retirements per kind. */
	retirements: ReflectionRetirement[];
};

const TidyReflectionsSchema = Type.Object({
	retire: Type.Optional(Type.Array(Type.Object({
		id: Type.String(),
		kind: Type.Union([Type.Literal("stale"), Type.Literal("duplicate"), Type.Literal("project-instructions")]),
		reason: Type.String(),
	}))),
	replace: Type.Optional(Type.Array(Type.Object({
		content: Type.String({ minLength: 1 }),
		replacesIds: Type.Array(Type.String(), { minItems: 1 }),
		reason: Type.String(),
	}))),
});

type TidyReflectionsArgs = Static<typeof TidyReflectionsSchema>;

export function reflectionToReviewLine(reflection: Reflection, recordedAt: string | undefined, isNew: boolean): string {
	return `[${reflection.id}] (recorded ${recordedAt ?? "unknown"})${isNew ? " [new]" : ""} ${reflection.content}`;
}

function unionSupportingIds(reflections: readonly Reflection[]): string[] {
	return Array.from(new Set(reflections.flatMap((reflection) => reflection.supportingObservationIds)));
}

export async function runReflectionReview(args: RunReflectionReviewArgs): Promise<ReflectionReviewResult | undefined> {
	const { model, apiKey, headers, env, reflections, newReflectionIds, retiredReflectionIds, recordedAt, observations, signal } = args;
	if (reflections.length === 0) return undefined;

	const activeById = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	// Every id is decided at most once per run; replacement targets count as decided so they stay active.
	const decided = new Set<string>();
	const plainRetirements: { id: string; kind?: ReflectionRetirementKind }[] = [];
	const replacements = new Map<string, Reflection>();
	const retirementsByTarget = new Map<string, string[]>();
	let toolCallCount = 0;
	let rejectedCount = 0;

	const tidyReflections: AgentTool<typeof TidyReflectionsSchema> = {
		name: "tidy_reflections",
		label: "Tidy reflections",
		description: "Retire reflections, or replace one or more reflections with one short reflection. Unmentioned reflections are kept.",
		parameters: TidyReflectionsSchema,
		execute: async (_id, params: TidyReflectionsArgs) => {
			toolCallCount++;
			const problems: string[] = [];
			const idProblem = (id: string): string | undefined => {
				if (!activeById.has(id)) return `${id} is not an active reflection`;
				if (decided.has(id)) return `${id} was already decided`;
				return undefined;
			};

			for (const item of params.retire ?? []) {
				const kind = isReflectionRetirementKind(item.kind) ? item.kind : undefined;
				const problem = idProblem(item.id) ?? (newReflectionIds.has(item.id) && kind !== "project-instructions"
					? `${item.id} is [new] and can be retired outright only as covered by project instructions; merge it into a replacement instead`
					: undefined);
				if (problem) {
					problems.push(problem);
					continue;
				}
				decided.add(item.id);
				plainRetirements.push({ id: item.id, ...(kind ? { kind } : {}) });
			}

			for (const item of params.replace ?? []) {
				const replacesIds = Array.from(new Set(item.replacesIds));
				const idProblems = replacesIds.map(idProblem).filter((problem): problem is string => problem !== undefined);
				if (idProblems.length > 0) {
					problems.push(`replacement rejected: ${idProblems.join(", ")}`);
					continue;
				}
				const content = normalizeContent(item.content);
				if (!content) {
					problems.push("replacement rejected: content must be a non-empty single line");
					continue;
				}
				const id = hashId(content);
				if (retiredReflectionIds.has(id) || replacesIds.includes(id)) {
					problems.push(`replacement rejected: its content matches a retired or replaced reflection; reword it`);
					continue;
				}
				if (activeById.has(id)) {
					if (decided.has(id) && !retirementsByTarget.has(id)) {
						problems.push(`replacement rejected: its content matches ${id}, which was already decided; reword it`);
						continue;
					}
					// Same content as a kept reflection: retire the replaced ids in its favor instead of recording a copy.
					decided.add(id);
					for (const replacedId of replacesIds) decided.add(replacedId);
					retirementsByTarget.set(id, [...(retirementsByTarget.get(id) ?? []), ...replacesIds]);
					continue;
				}
				for (const replacedId of replacesIds) decided.add(replacedId);
				const previous = replacements.get(id);
				const allReplaced = [...(previous?.replaces ?? []), ...replacesIds];
				replacements.set(id, {
					id,
					content,
					supportingObservationIds: unionSupportingIds(allReplaced.map((replacedId) => activeById.get(replacedId)!)),
					tokenCount: estimateStringTokens(content),
					replaces: allReplaced,
				});
			}

			rejectedCount += problems.length;
			const replacedCount = Array.from(replacements.values()).reduce((sum, replacement) => sum + replacement.replaces!.length, 0)
				+ Array.from(retirementsByTarget.values()).reduce((sum, ids) => sum + ids.length, 0);
			const untouched = reflections.filter((reflection) => !decided.has(reflection.id)).length;
			const text = `Recorded. Retired ${plainRetirements.length}, replaced ${replacedCount} with ${replacements.size + retirementsByTarget.size}, ${untouched} untouched.${problems.length > 0 ? ` Problems: ${problems.join("; ")}` : ""}`;
			return {
				content: [{ type: "text", text }],
				details: { retired: plainRetirements.length, replaced: replacedCount, problems: problems.length },
			};
		},
	};

	const reflectionLines = reflections.map((reflection) => reflectionToReviewLine(reflection, recordedAt.get(reflection.id), newReflectionIds.has(reflection.id)));
	const userText = withProjectContext(args.projectContext, `CURRENT REFLECTIONS:\n${joinOrEmpty(reflectionLines)}\n\nRECENT OBSERVATIONS:\n${joinOrEmpty(observations.map(observationToSummaryLine))}\n\nReview the reflections. If none needs to change, do not call the tool.`);
	const { system, prompts } = workerMessages(model, REVIEW_SYSTEM, userText);
	const context: AgentContext = {
		messages: system,
		tools: [tidyReflections as AgentTool<any>],
	};
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
	const stream = loop(
		prompts,
		context,
		config,
		signal,
		resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple),
	);
	for await (const event of stream) {
		// Tool execution collects decisions.
		logAgentStreamError("review", event);
	}
	await stream.result();

	// Plain retirements are grouped by kind in first-seen order; kindless ones keep the pre-kind entry shape.
	const plainByKind = new Map<ReflectionRetirementKind | undefined, string[]>();
	for (const { id, kind } of plainRetirements) plainByKind.set(kind, [...(plainByKind.get(kind) ?? []), id]);
	const retirements: ReflectionRetirement[] = [
		...Array.from(replacements.values()).map((replacement) => ({ reflectionIds: replacement.replaces!, replacedBy: replacement.id })),
		...Array.from(retirementsByTarget, ([replacedBy, reflectionIds]) => ({ reflectionIds, replacedBy })),
		...Array.from(plainByKind, ([kind, reflectionIds]) => (kind ? { reflectionIds, kind } : { reflectionIds })),
	];
	debugLog("reflector.review_result", {
		toolCallCount,
		reflectionCount: reflections.length,
		replacementCount: replacements.size,
		retiredCount: retirements.reduce((sum, retirement) => sum + retirement.reflectionIds.length, 0),
		plainRetiredCount: plainRetirements.length,
		projectInstructionsRetiredCount: plainByKind.get("project-instructions")?.length ?? 0,
		rejectedCount,
	});
	return retirements.length > 0 ? { replacements: Array.from(replacements.values()), retirements } : undefined;
}

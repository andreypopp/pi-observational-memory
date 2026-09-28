import type { StaleTextReport } from "./agents/reviewer/grounding.js";
import type { ConsolidationPhase } from "./runtime.js";

/** Counts a consolidation pass accumulates when a caller asks for a report (the /om:reflect pass). */
export type ConsolidationReport = {
	observationsRecorded: number;
	/** New reflections from crystallize. */
	reflectionsAdded: number;
	/** Reflections the review retired in favor of a replacement. */
	reflectionsReplaced: number;
	/** Replacement reflections the review recorded. */
	replacementsRecorded: number;
	/** Reflections the review retired outright. */
	reflectionsRetired: number;
	observationsDropped: number;
};

export type MemorySize = {
	reflections: number;
	observations: number;
	reflectionTokens: number;
	observationTokens: number;
};

export type ReflectReport = ConsolidationReport & {
	/** Set by the compaction hook when it consumed the request and started the forced pass. */
	started: boolean;
	/** Set when Pi had nothing to compact, so the pass ran without a fold. */
	uncompacted?: true;
	/** Summary size before (latest visible projection) and after (this full fold). */
	before?: MemorySize;
	after?: MemorySize;
};

/** A stage of the forced pass, for progress labels; "fold" is the compaction hook's full fold. */
export type PassStage = ConsolidationPhase | "fold";

/** Sent with the "review" stage: how many active reflections it reviews. */
export type PassProgressDetail = { reflections: number };

/**
 * /om:ground's part of a forced pass: its review checks memory against the repository with tools.
 * The pass fills in the results for the command's report.
 */
export type GroundingRequest = {
	/** Called after each repo tool call, with `toolCalls` already counted. */
	onToolCall?: () => void;
	toolCalls: number;
	/** Set when the grounding review ran. */
	reviewed: boolean;
	reflectionsRetiredStale: number;
	reflectionsRewritten: number;
	staleText: StaleTextReport[];
};

/** One-shot /om:reflect (or /om:ground) request, consumed by the next compaction hook. */
export type ReflectRequest = {
	report: ReflectReport;
	/** The command's trimmed arguments, for both reflector calls; absent when there were none. */
	instruction?: string;
	/** Set by /om:ground. */
	grounding?: GroundingRequest;
	/** Called as each stage of the pass starts. */
	onProgress?: (stage: PassStage, detail?: PassProgressDetail) => void;
};

export function emptyReflectReport(): ReflectReport {
	return {
		started: false,
		observationsRecorded: 0,
		reflectionsAdded: 0,
		reflectionsReplaced: 0,
		replacementsRecorded: 0,
		reflectionsRetired: 0,
		observationsDropped: 0,
	};
}

export function memorySize(projection: { reflections: { tokenCount: number }[]; observations: { tokenCount: number }[] }): MemorySize {
	const tokens = (items: { tokenCount: number }[]) => items.reduce((sum, item) => sum + item.tokenCount, 0);
	return {
		reflections: projection.reflections.length,
		observations: projection.observations.length,
		reflectionTokens: tokens(projection.reflections),
		observationTokens: tokens(projection.observations),
	};
}

function sizeLine(label: string, before: number, after: number, beforeTokens: number, afterTokens: number): string {
	return `${label}: ${before.toLocaleString()} → ${after.toLocaleString()} (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)`;
}

/** The one-line echo of a command's instruction, for its start notice and report; [] without one. */
export function instructionLine(instruction: string | undefined): string[] {
	return instruction ? [`Instruction: ${instruction.replace(/\s+/g, " ")}`] : [];
}

export function renderReflectReport(report: ReflectReport, instruction?: string): string {
	const lines = [
		"Observational memory: reflection pass complete",
		...instructionLine(instruction),
		`Observations: +${report.observationsRecorded} recorded, -${report.observationsDropped} dropped`,
		`Reflections: +${report.reflectionsAdded} new, ${report.reflectionsReplaced} replaced by ${report.replacementsRecorded}, ${report.reflectionsRetired} retired`,
	];
	const { before, after } = report;
	if (before && after) {
		lines.push(
			sizeLine("Summary reflections", before.reflections, after.reflections, before.reflectionTokens, after.reflectionTokens),
			sizeLine("Summary observations", before.observations, after.observations, before.observationTokens, after.observationTokens),
		);
	} else if (report.uncompacted) {
		lines.push("Pi had nothing to compact yet; the agent sees this memory after a later compaction.");
	} else if (before) {
		lines.push("Memory is empty; Pi's native summary was used.");
	}
	return lines.join("\n");
}

export function renderGroundReport(report: ReflectReport, grounding: GroundingRequest, instruction?: string): string {
	const lines = [renderReflectReport(report, instruction)];
	if (!grounding.reviewed) {
		lines.push("Grounding: the grounding review did not run; /om:status shows any memory worker error.");
		return lines.join("\n");
	}
	lines.push(
		`Grounding: ${grounding.toolCalls} tool call${grounding.toolCalls === 1 ? "" : "s"}; ${grounding.reflectionsRetiredStale} reflection${grounding.reflectionsRetiredStale === 1 ? "" : "s"} retired as stale, ${grounding.reflectionsRewritten} rewritten`,
	);
	if (grounding.staleText.length === 0) lines.push("Stale hand-written text: none found");
	else {
		lines.push("Stale hand-written text (not edited):");
		for (const item of grounding.staleText) lines.push(`- ${item.path}: "${item.excerpt}" — ${item.reason}`);
	}
	return lines.join("\n");
}

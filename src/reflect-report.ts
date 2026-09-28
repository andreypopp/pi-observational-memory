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

/** One-shot /om:reflect request, consumed by the next compaction hook. */
export type ReflectRequest = {
	report: ReflectReport;
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

export function renderReflectReport(report: ReflectReport): string {
	const lines = [
		"Observational memory: reflection pass complete",
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

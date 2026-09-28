import type { PromotedLineRevision } from "../agents/reviewer/grounding.js";
import type { ProposedPromotedLine } from "../agents/promoter/agent.js";
import { hashId } from "../ids.js";
import type { FoldedLedger } from "../session-ledger/index.js";
import { parsePromotedMemory, readPromotedMemory, renderPromotedLine, type PromotedLine } from "./memory-file.js";
import { promotedLineRecords, buildPromotePlan, type PromotePlan } from "./promote.js";
import { displayPath, type PromoteTarget } from "./target.js";

export type GroundPromotePlan = { ok: true; plan: PromotePlan; rewritten: number; removed: number } | { ok: false; reason: string };

function sameLines(a: readonly PromotedLine[], b: readonly PromotedLine[]): boolean {
	return a.length === b.length && a.every((line, index) => line.id === b[index].id && line.raw === b[index].raw);
}

/**
 * Turn /om:ground's block revisions into an /om:promote plan against the file as it is now and the live
 * branch: other lines are kept, rewrites become new reflections replacing the line's record, removed
 * lines' reflections are retired as stale with the evidence. Refuses when the block changed since the
 * review read it.
 */
export function buildGroundPromotePlan(args: {
	target: PromoteTarget;
	reviewedLines: readonly PromotedLine[];
	revisions: readonly PromotedLineRevision[];
	folded: FoldedLedger;
	sessionId: string | undefined;
	promotedAt: string;
	cwd: string;
}): GroundPromotePlan {
	const { target, folded } = args;
	const originalContent = readPromotedMemory(target.memoryPath);
	const { lines } = parsePromotedMemory(originalContent ?? "");
	if (!sameLines(lines, args.reviewedLines)) {
		return { ok: false, reason: `the promoted lines in ${displayPath(target.memoryPath, args.cwd)} changed during grounding` };
	}

	const revisionById = new Map(args.revisions.map((revision) => [revision.id, revision]));
	const records = promotedLineRecords(lines, folded, target.memoryDir);
	const proposedLines: ProposedPromotedLine[] = [];
	const reasons = new Map<string, string>();
	const staleRetirements: NonNullable<PromotePlan["staleRetirements"]> = [];
	let rewritten = 0;
	let removed = 0;
	for (const line of lines) {
		const revision = revisionById.get(line.id);
		const record = records.get(line.id);
		if (revision?.action === "remove") {
			removed++;
			if (folded.reflectionsById.has(line.id)) staleRetirements.push({ reflectionIds: [line.id], reason: revision.reason });
			continue;
		}
		if (revision?.action === "rewrite" && record && record.supportingObservationIds.length > 0) {
			const id = hashId(revision.content);
			rewritten++;
			reasons.set(id, revision.reason);
			proposedLines.push({
				kind: "rewrite",
				id,
				line: renderPromotedLine(id, revision.content),
				content: revision.content,
				fromIds: [line.id],
				replaces: [record.id],
				supportingObservationIds: record.supportingObservationIds,
			});
			continue;
		}
		proposedLines.push({ kind: "keep", id: line.id, line: line.raw.trim() });
	}

	const plan = buildPromotePlan({ target, originalContent, proposedLines, folded, sessionId: args.sessionId, promotedAt: args.promotedAt });
	return {
		ok: true,
		plan: {
			...plan,
			replacements: plan.replacements.map((replacement) => {
				const reason = reasons.get(replacement.replacedBy);
				return reason ? { ...replacement, reason } : replacement;
			}),
			...(staleRetirements.length > 0 ? { staleRetirements } : {}),
		},
		rewritten,
		removed,
	};
}

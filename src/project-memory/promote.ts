import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PromoteSourceRecord, ProposedBlockLine } from "../agents/promoter/agent.js";
import {
	buildReflectionsDroppedData,
	buildReflectionsRecordedData,
	latestCoverageMarkerId,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type FoldedLedger,
	type Reflection,
	type ReflectionsDroppedEntryData,
	type ReflectionsRecordedEntryData,
} from "../session-ledger/index.js";
import { estimateStringTokens } from "../tokens.js";
import { blockTokens, parseContextFile, replaceBlock, type BlockLine } from "./block.js";
import { memoryClosure, reflectionToMemoryRecord } from "./closure.js";
import { listMemoryFileIds, readMemoryRecord, removeMemoryFiles, writeNewMemoryFiles, type MemoryRecord } from "./store.js";
import { displayPath, type PromoteTarget } from "./target.js";

export type PromotePlan = {
	target: PromoteTarget;
	/** The context file as read before the model call; undefined when it did not exist. */
	originalContent: string | undefined;
	currentLines: BlockLine[];
	proposedLines: ProposedBlockLine[];
	currentTokens: number;
	tokens: number;
	newContent: string;
	/** New `.memory/` files, promoted reflections first. */
	memoryRecords: MemoryRecord[];
	existingMemoryIds: string[];
	missingMemoryIds: string[];
	/** Sorted ids of `.memory/` files the new block no longer links to: removed on apply. */
	orphanMemoryIds: string[];
	/** Rewritten lines, recorded as new reflections. */
	recordedReflections: Reflection[];
	/** One retirement per rewrite, for its sources in the branch ledger. */
	replacements: { reflectionIds: string[]; replacedBy: string }[];
	/** Promoted reflection ids to retire with kind "promoted": pure promotions and rewrites. */
	promotedIds: string[];
	/** Active reflections the plan relies on; each must still be active when it is applied. */
	activeSourceIds: string[];
};

export function readContextFile(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Reflection records behind the block's id lines: the branch ledger first, then `.memory/`. */
export function blockLineRecords(lines: readonly BlockLine[], folded: FoldedLedger, memoryDir: string): Map<string, PromoteSourceRecord> {
	const records = new Map<string, PromoteSourceRecord>();
	for (const line of lines) {
		if (!line.hasId) continue;
		const ledger = folded.reflectionsById.get(line.id);
		const stored = ledger ? undefined : readMemoryRecord(memoryDir, line.id);
		const record = ledger ?? (stored?.kind === "reflection" ? stored : undefined);
		if (record) records.set(line.id, { id: record.id, content: record.content, supportingObservationIds: record.supportingObservationIds });
	}
	return records;
}

/** Everything /om:promote would write for a proposed block; reads `.memory/` but writes nothing. */
export function buildPromotePlan(args: {
	target: PromoteTarget;
	originalContent: string | undefined;
	proposedLines: ProposedBlockLine[];
	folded: FoldedLedger;
	sessionId: string | undefined;
	promotedAt: string;
}): PromotePlan {
	const { target, originalContent, proposedLines, folded, sessionId, promotedAt } = args;
	const content = originalContent ?? "";
	const parsed = parseContextFile(content);
	const currentLines = parsed.lines;
	const lineTexts = proposedLines.map((line) => line.line);
	const recordedReflections: Reflection[] = [];
	const replacements: PromotePlan["replacements"] = [];
	const promotedRecords: MemoryRecord[] = [];
	const activeIds = new Set(folded.activeReflections.map((reflection) => reflection.id));
	const activeSourceIds = new Set<string>();

	for (const line of proposedLines) {
		if (line.kind === "promote") {
			activeSourceIds.add(line.id);
			promotedRecords.push(reflectionToMemoryRecord(line.reflection, sessionId, promotedAt));
			continue;
		}
		if (line.kind !== "rewrite") continue;
		for (const id of line.fromIds) if (activeIds.has(id)) activeSourceIds.add(id);
		const reflection: Reflection = {
			id: line.id,
			content: line.content,
			supportingObservationIds: line.supportingObservationIds,
			tokenCount: estimateStringTokens(line.content),
			...(line.replaces.length > 0 ? { replaces: line.replaces } : {}),
		};
		recordedReflections.push(reflection);
		promotedRecords.push(reflectionToMemoryRecord(reflection, sessionId, promotedAt));
		const inLedger = line.fromIds.filter((id) => folded.reflectionsById.has(id));
		if (inLedger.length > 0) replacements.push({ reflectionIds: inLedger, replacedBy: line.id });
	}

	const idLines = new Set(currentLines.filter((line) => line.hasId).map((line) => line.id));
	const keptIds = proposedLines.filter((line) => line.kind === "keep" && idLines.has(line.id)).map((line) => line.id);
	const closure = memoryClosure(
		promotedRecords,
		{
			reflectionsById: folded.reflectionsById,
			observationsById: folded.observationsById,
			sessionId,
			memoryDir: target.memoryDir,
		},
		keptIds,
	);
	const promotedIds = proposedLines.filter((line) => line.kind === "promote" || line.kind === "rewrite").map((line) => line.id);

	return {
		target,
		originalContent,
		currentLines,
		proposedLines,
		currentTokens: blockTokens(currentLines.map((line) => line.raw.trim())),
		tokens: blockTokens(lineTexts),
		newContent: replaceBlock(content, lineTexts, parsed),
		memoryRecords: closure.records,
		existingMemoryIds: closure.existingIds,
		missingMemoryIds: closure.missingIds,
		orphanMemoryIds: listMemoryFileIds(target.memoryDir).filter((id) => !closure.reachableIds.has(id)),
		recordedReflections,
		replacements,
		promotedIds,
		activeSourceIds: Array.from(activeSourceIds),
	};
}

/** Whether applying the plan would change anything. */
export function planChangesSomething(plan: PromotePlan): boolean {
	return plan.newContent !== (plan.originalContent ?? "") || plan.memoryRecords.length > 0 || plan.orphanMemoryIds.length > 0 || plan.promotedIds.length > 0;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

function lineCounts(plan: PromotePlan): { added: number; kept: number; removed: number } {
	const proposedIds = new Set(plan.proposedLines.map((line) => line.id));
	const kept = plan.proposedLines.filter((line) => line.kind === "keep").length;
	return {
		added: plan.proposedLines.length - kept,
		kept,
		removed: plan.currentLines.filter((line) => !proposedIds.has(line.id)).length,
	};
}

/** One line for the confirm dialog. */
export function promoteSummary(plan: PromotePlan, cwd: string): string {
	const { added, kept, removed } = lineCounts(plan);
	return `${displayPath(plan.target.contextPath, cwd)}: +${added} / =${kept} / -${removed} lines (~${plan.tokens} tokens), +${plan.memoryRecords.length} / -${plan.orphanMemoryIds.length} .memory files. Apply?`;
}

/** The full preview: block diff, `.memory/` files, ledger changes and budget. */
export function renderPromotePreview(plan: PromotePlan, cwd: string, maxTokens: number): string {
	const { target } = plan;
	const proposedIds = new Set(plan.proposedLines.map((line) => line.id));
	const lines: string[] = ["Observational memory: /om:promote preview", ""];
	lines.push(`Target: ${displayPath(target.contextPath, cwd)}${target.contextExists ? "" : " (new file)"}`);
	if (target.linkedWorktreeRoot) {
		lines.push(`This is a linked git worktree (${target.linkedWorktreeRoot}); the block and .memory/ go to the main worktree at ${target.root}.`);
	}
	lines.push(`Block: ~${plan.tokens} / ${maxTokens} tokens (was ~${plan.currentTokens})`, "");
	for (const line of plan.currentLines) if (!proposedIds.has(line.id)) lines.push(`- ${line.raw.trim()}`);
	for (const line of plan.proposedLines) lines.push(`${line.kind === "keep" ? "=" : "+"} ${line.line}`);
	if (plan.currentLines.length === 0 && plan.proposedLines.length === 0) lines.push("(empty block)");
	lines.push("");
	const memoryDir = displayPath(target.memoryDir, cwd);
	lines.push(plan.memoryRecords.length > 0
		? `${memoryDir}/: add ${plural(plan.memoryRecords.length, "file")}: ${plan.memoryRecords.map((record) => record.id).join(", ")}`
		: `${memoryDir}/: no new files`);
	if (plan.orphanMemoryIds.length > 0) {
		lines.push(`${memoryDir}/: remove ${plural(plan.orphanMemoryIds.length, "file")} the block no longer links to: ${plan.orphanMemoryIds.join(", ")}`);
	}
	if (plan.existingMemoryIds.length > 0) lines.push(`Already in ${memoryDir}/: ${plan.existingMemoryIds.join(", ")}`);
	if (plan.missingMemoryIds.length > 0) lines.push(`Not found, skipped: ${plan.missingMemoryIds.join(", ")}`);
	const replacedCount = plan.replacements.reduce((sum, replacement) => sum + replacement.reflectionIds.length, 0);
	const ledger = [
		plan.recordedReflections.length > 0 ? `record ${plural(plan.recordedReflections.length, "rewritten reflection")}` : undefined,
		replacedCount > 0 ? `retire ${replacedCount} replaced` : undefined,
		plan.promotedIds.length > 0 ? `mark ${plan.promotedIds.length} promoted (they leave active memory)` : undefined,
	].filter((part): part is string => part !== undefined);
	lines.push(`Memory ledger: ${ledger.length > 0 ? ledger.join("; ") : "no changes"}`);
	return lines.join("\n");
}

/** Write through a temp file and rename; a symlinked context file is written at its real path. */
function writeFileAtomically(path: string, content: string): void {
	const realPath = existsSync(path) ? realpathSync(path) : path;
	const temp = join(dirname(realPath), `.${basename(realPath)}.om-promote-${process.pid}-${Date.now()}.tmp`);
	try {
		writeFileSync(temp, content);
		renameSync(temp, realPath);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export type PromoteLedgerEntries = {
	recorded?: ReflectionsRecordedEntryData;
	dropped: ReflectionsDroppedEntryData[];
};

/** The ledger entries a plan appends: rewrites recorded, their sources replaced, then every promoted id retired. */
export function promoteLedgerEntries(plan: PromotePlan, coversUpToId: string): PromoteLedgerEntries {
	const recorded = buildReflectionsRecordedData(plan.recordedReflections, coversUpToId);
	const dropped = [
		...plan.replacements.map((replacement) => buildReflectionsDroppedData(replacement.reflectionIds, coversUpToId, replacement.replacedBy)),
		buildReflectionsDroppedData(plan.promotedIds, coversUpToId, undefined, "promoted"),
	].filter((data): data is ReflectionsDroppedEntryData => data !== undefined);
	return { ...(recorded ? { recorded } : {}), dropped };
}

/** Why the plan can no longer be applied, or undefined when it still can. */
export function stalePlanReason(plan: PromotePlan, folded: FoldedLedger, cwd: string): string | undefined {
	if (readContextFile(plan.target.contextPath) !== plan.originalContent) {
		return `${displayPath(plan.target.contextPath, cwd)} changed on disk since the preview`;
	}
	const activeIds = new Set(folded.activeReflections.map((reflection) => reflection.id));
	const gone = plan.activeSourceIds.filter((id) => !activeIds.has(id));
	if (gone.length > 0) return `reflections changed since the preview (${gone.join(", ")} no longer active)`;
	const taken = plan.recordedReflections.filter((reflection) => folded.retiredReflectionIds.has(reflection.id) || activeIds.has(reflection.id));
	if (taken.length > 0) return `reflections changed since the preview (${taken.map((reflection) => reflection.id).join(", ")} recorded meanwhile)`;
	return undefined;
}

export type ApplyResult = { ok: true; memoryFilesWritten: string[]; memoryFilesRemoved: string[] } | { ok: false; reason: string };

/**
 * Apply a confirmed plan in order: new `.memory/` files, the context file (temp + rename), orphaned
 * `.memory/` files, then the ledger entries. Aborts without writing when the context file or the reflections changed since the preview.
 */
export function applyPromotePlan(
	plan: PromotePlan,
	entries: Entry[],
	folded: FoldedLedger,
	appendEntry: (customType: string, data: unknown) => void,
	cwd: string,
): ApplyResult {
	const stale = stalePlanReason(plan, folded, cwd);
	if (stale) return { ok: false, reason: stale };
	const memoryFilesWritten = writeNewMemoryFiles(plan.target.memoryDir, plan.memoryRecords);
	if (plan.newContent !== (plan.originalContent ?? "")) writeFileAtomically(plan.target.contextPath, plan.newContent);
	const memoryFilesRemoved = removeMemoryFiles(plan.target.memoryDir, plan.orphanMemoryIds);
	const coversUpToId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED) ?? entries.at(-1)?.id;
	if (coversUpToId) {
		const ledger = promoteLedgerEntries(plan, coversUpToId);
		if (ledger.recorded) appendEntry(OM_REFLECTIONS_RECORDED, ledger.recorded);
		for (const data of ledger.dropped) appendEntry(OM_REFLECTIONS_DROPPED, data);
	}
	return { ok: true, memoryFilesWritten, memoryFilesRemoved };
}

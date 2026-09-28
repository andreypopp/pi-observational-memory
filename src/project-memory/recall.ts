import {
	resolveObservationSources,
	type Entry,
	type Observation,
	type RecallResult,
	type RecalledObservation,
	type Reflection,
} from "../session-ledger/recall.js";
import { estimateStringTokens } from "../tokens.js";
import { findSessionFile, readSessionEntries } from "./sessions.js";
import { findMemoryDirFor, memoryDirCandidates, readMemoryRecord, type ParsedMemoryFile } from "./store.js";
import { resolvePromoteTarget } from "./target.js";

export type ProjectMemoryRecall = {
	result: Extract<RecallResult, { status: "found" }>;
	memoryDir: string;
	/** Records whose text was edited since promotion (the body no longer hashes to the id). */
	editedIds: string[];
	/** Sessions holding source entries that are not on this machine. */
	unavailableSessions: string[];
};

export type ProjectMemorySessionAccess = {
	branchEntries: Entry[];
	sessionId?: string;
	sessionDir?: string;
};

function toObservation(record: Extract<ParsedMemoryFile, { kind: "observation" }>): Observation {
	return {
		id: record.id,
		content: record.content,
		timestamp: record.timestamp,
		relevance: record.relevance,
		sourceEntryIds: record.sourceEntryIds,
		tokenCount: estimateStringTokens(record.content),
	};
}

function toReflection(record: Extract<ParsedMemoryFile, { kind: "reflection" }>): Reflection {
	return {
		id: record.id,
		content: record.content,
		supportingObservationIds: record.supportingObservationIds,
		tokenCount: estimateStringTokens(record.content),
		...(record.replaces ? { replaces: record.replaces } : {}),
	};
}

/**
 * Recall a memory id from the nearest `.memory/` store (ancestors of cwd, then the promote target's
 * store), following its links through the store. Sources come from the current branch for the current
 * session, else from that session's file among the project's session directories.
 */
export function recallFromProjectMemory(cwd: string, memoryId: string, access: ProjectMemorySessionAccess): ProjectMemoryRecall | undefined {
	// The promote target's store is resolved (a git lookup) only when no ancestor store has the id.
	const memoryDir = findMemoryDirFor(memoryDirCandidates(cwd), memoryId) ?? findMemoryDirFor([resolvePromoteTarget(cwd).memoryDir], memoryId);
	if (!memoryDir) return undefined;
	const record = readMemoryRecord(memoryDir, memoryId);
	if (!record) return undefined;

	const editedIds = record.bodyMatchesId ? [] : [record.id];
	const unavailableSessions = new Set<string>();
	// Session file per id; entries are read per observation, since each needs its own source ids
	// (readSessionEntries caches the file's text).
	const sessionFiles = new Map<string, string | undefined>();

	const entriesFor = (session: string | undefined, sourceEntryIds: string[]): Entry[] | undefined => {
		if (!session || session === access.sessionId) return access.branchEntries;
		if (!sessionFiles.has(session)) sessionFiles.set(session, access.sessionDir ? findSessionFile(access.sessionDir, session) : undefined);
		const file = sessionFiles.get(session);
		if (!file) {
			unavailableSessions.add(session);
			return undefined;
		}
		return readSessionEntries(file, new Set(sourceEntryIds));
	};

	const recallObservation = (observationRecord: Extract<ParsedMemoryFile, { kind: "observation" }>): RecalledObservation => {
		if (!observationRecord.bodyMatchesId && !editedIds.includes(observationRecord.id)) editedIds.push(observationRecord.id);
		const observation = toObservation(observationRecord);
		const entries = entriesFor(observationRecord.session, observation.sourceEntryIds) ?? [];
		return resolveObservationSources(entries, observation);
	};

	const observations: RecalledObservation[] = [];
	const missingSupportingObservationIds: string[] = [];
	const reflections: Extract<RecallResult, { status: "found" }>["reflections"] = [];
	if (record.kind === "observation") {
		observations.push(recallObservation(record));
	} else {
		const reflection = toReflection(record);
		const replacedIds = Array.from(new Set(reflection.replaces ?? []));
		const replaced = replacedIds.flatMap((id) => {
			const stored = readMemoryRecord(memoryDir, id);
			return stored?.kind === "reflection" ? [toReflection(stored)] : [];
		});
		reflections.push({
			reflection,
			status: "active",
			replacedReflections: replaced,
			missingReplacedReflectionIds: replacedIds.filter((id) => !replaced.some((item) => item.id === id)),
		});
		for (const observationId of Array.from(new Set(reflection.supportingObservationIds))) {
			const stored = readMemoryRecord(memoryDir, observationId);
			if (stored?.kind === "observation") observations.push(recallObservation(stored));
			else missingSupportingObservationIds.push(observationId);
		}
	}

	const sourceEntries = Array.from(new Map(observations.flatMap((match) => match.sourceEntries).map((entry) => [entry.id, entry])).values());
	const missingSourceEntryIds = Array.from(new Set(observations.flatMap((match) => match.missingSourceEntryIds)));
	const nonSourceEntryIds = Array.from(new Set(observations.flatMap((match) => match.nonSourceEntryIds)));
	return {
		result: {
			status: "found",
			memoryId,
			kind: record.kind,
			reflections,
			observations,
			sourceEntries,
			missingSourceEntryIds,
			nonSourceEntryIds,
			missingSupportingObservationIds,
			collision: false,
			partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || missingSupportingObservationIds.length > 0,
		},
		memoryDir,
		editedIds,
		unavailableSessions: Array.from(unavailableSessions),
	};
}

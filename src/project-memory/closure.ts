import type { Observation, Reflection } from "../session-ledger/types.js";
import { memoryFileExists, readMemoryRecord, type MemoryRecord } from "./store.js";

export type ClosureSources = {
	reflectionsById: ReadonlyMap<string, Reflection>;
	observationsById: ReadonlyMap<string, Observation>;
	/** Session id recorded on records copied from the branch ledger. */
	sessionId?: string;
	/** Existing `.memory/` store, for links to records only there. */
	memoryDir: string;
};

export type MemoryClosure = {
	/** Records to write as new files, promoted reflections first. */
	records: MemoryRecord[];
	/** Linked ids already present in `.memory/`: nothing to write. */
	existingIds: string[];
	/** Linked ids found neither in the branch ledger nor in `.memory/`. */
	missingIds: string[];
};

function reflectionRecord(reflection: Reflection, sessionId: string | undefined): MemoryRecord {
	return {
		kind: "reflection",
		id: reflection.id,
		content: reflection.content,
		...(sessionId ? { session: sessionId } : {}),
		...(reflection.replaces && reflection.replaces.length > 0 ? { replaces: reflection.replaces } : {}),
		supportingObservationIds: reflection.supportingObservationIds,
	};
}

function observationRecord(observation: Observation, sessionId: string | undefined): MemoryRecord {
	return {
		kind: "observation",
		id: observation.id,
		content: observation.content,
		timestamp: observation.timestamp,
		relevance: observation.relevance,
		...(sessionId ? { session: sessionId } : {}),
		sourceEntryIds: observation.sourceEntryIds,
	};
}

/** Strip parse-only fields from a record read from `.memory/`. */
function storedRecord(record: NonNullable<ReturnType<typeof readMemoryRecord>>): MemoryRecord {
	const { bodyMatchesId: _bodyMatchesId, ...rest } = record;
	if (rest.kind === "reflection") {
		const { promotedAt: _promotedAt, ...reflection } = rest;
		return reflection;
	}
	return rest;
}

/**
 * Everything the promoted reflections link to, transitively: the reflections they replace (recursively)
 * and the supporting observations of every reflection reached. Records come from the branch ledger,
 * including retired and dropped ones, or from `.memory/` when a link points only there. Promoted
 * reflections are always written as new records carrying `promotedAt`, unless their file already exists.
 */
export function memoryClosure(promoted: readonly MemoryRecord[], sources: ClosureSources): MemoryClosure {
	const records: MemoryRecord[] = [];
	const existingIds: string[] = [];
	const missingIds: string[] = [];
	const seen = new Set<string>();
	const queue: { id: string; kind: MemoryRecord["kind"]; record?: MemoryRecord }[] = promoted.map((record) => ({ id: record.id, kind: record.kind, record }));

	while (queue.length > 0) {
		const item = queue.shift()!;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		let record = item.record;
		const onDisk = memoryFileExists(sources.memoryDir, item.id);
		if (!record) {
			if (item.kind === "reflection") {
				const reflection = sources.reflectionsById.get(item.id);
				if (reflection) record = reflectionRecord(reflection, sources.sessionId);
			} else {
				const observation = sources.observationsById.get(item.id);
				if (observation) record = observationRecord(observation, sources.sessionId);
			}
			if (!record && onDisk) {
				const stored = readMemoryRecord(sources.memoryDir, item.id);
				if (stored?.kind === item.kind) record = storedRecord(stored);
			}
		}
		if (!record) {
			if (onDisk) existingIds.push(item.id);
			else missingIds.push(item.id);
			continue;
		}
		if (onDisk) existingIds.push(item.id);
		else records.push(record);
		if (record.kind === "reflection") {
			for (const id of record.replaces ?? []) queue.push({ id, kind: "reflection" });
			for (const id of record.supportingObservationIds) queue.push({ id, kind: "observation" });
		}
	}

	return { records, existingIds, missingIds };
}

export function reflectionToMemoryRecord(reflection: Reflection, sessionId: string | undefined, promotedAt?: string): MemoryRecord {
	const record = reflectionRecord(reflection, sessionId);
	return promotedAt && record.kind === "reflection" ? { ...record, promotedAt } : record;
}

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
	/** Ids the promoted reflections and kept ids reach; see memoryClosure. */
	reachableIds: Set<string>;
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
 *
 * `reachableIds` is every id reachable from the promoted reflections and `keptIds` (the block's kept id
 * lines) over the same links, where a reflection's links are the union over its given record, the branch
 * ledger and its `.memory/` file, so garbage collection never under-approximates. Kept ids only feed
 * `reachableIds`: nothing reached solely through them is written or reported as existing or missing.
 */
export function memoryClosure(promoted: readonly MemoryRecord[], sources: ClosureSources, keptIds: readonly string[] = []): MemoryClosure {
	const records: MemoryRecord[] = [];
	const existingIds: string[] = [];
	const missingIds: string[] = [];
	const reachableIds = new Set<string>();
	const copied = new Set<string>();
	const expanded = new Set<string>();
	const storedById = new Map<string, ReturnType<typeof readMemoryRecord>>();
	const stored = (id: string) => {
		if (!storedById.has(id)) storedById.set(id, readMemoryRecord(sources.memoryDir, id));
		return storedById.get(id);
	};
	type Item = { id: string; kind: MemoryRecord["kind"]; copy: boolean; record?: MemoryRecord };
	const queue: Item[] = [
		...promoted.map((record): Item => ({ id: record.id, kind: record.kind, copy: true, record })),
		...keptIds.map((id): Item => ({ id, kind: "reflection", copy: false })),
	];
	const follow = (links: Pick<Reflection, "replaces" | "supportingObservationIds">, copy: boolean) => {
		for (const id of links.replaces ?? []) queue.push({ id, kind: "reflection", copy });
		for (const id of links.supportingObservationIds) queue.push({ id, kind: "observation", copy });
	};

	while (queue.length > 0) {
		const item = queue.shift()!;
		reachableIds.add(item.id);
		const copy = item.copy && !copied.has(item.id);
		const expand = item.kind === "reflection" && !expanded.has(item.id);
		if (!copy && !expand) continue;
		const onDisk = memoryFileExists(sources.memoryDir, item.id);
		const ledgerReflection = item.kind === "reflection" ? sources.reflectionsById.get(item.id) : undefined;
		const ledgerObservation = item.kind === "observation" ? sources.observationsById.get(item.id) : undefined;

		if (copy) {
			copied.add(item.id);
			let record = item.record;
			if (!record && ledgerReflection) record = reflectionRecord(ledgerReflection, sources.sessionId);
			if (!record && ledgerObservation) record = observationRecord(ledgerObservation, sources.sessionId);
			if (!record && onDisk) {
				const found = stored(item.id);
				if (found?.kind === item.kind) record = storedRecord(found);
			}
			if (onDisk) existingIds.push(item.id);
			else if (record) records.push(record);
			else missingIds.push(item.id);
			if (record?.kind === "reflection") follow(record, true);
		}

		// A given record's links were followed by the copy step above.
		if (expand) {
			expanded.add(item.id);
			if (ledgerReflection) follow(ledgerReflection, false);
			const found = onDisk ? stored(item.id) : undefined;
			if (found?.kind === "reflection") follow(found, false);
		}
	}

	return { records, existingIds, missingIds, reachableIds };
}

export function reflectionToMemoryRecord(reflection: Reflection, sessionId: string | undefined, promotedAt?: string): MemoryRecord {
	const record = reflectionRecord(reflection, sessionId);
	return promotedAt && record.kind === "reflection" ? { ...record, promotedAt } : record;
}

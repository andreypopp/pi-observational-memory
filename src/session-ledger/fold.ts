import {
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsDroppedData,
	isReflectionsRecordedData,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";

export type FoldLedgerOptions = {
	/** Fold entries from branch root through this entry id, inclusive. Omit to fold through branch tip. */
	upToEntryId?: string;
};

export type FoldedLedger = {
	/** All first-valid observation records encountered through the fold boundary, including dropped observations. */
	observations: Observation[];
	/** Observation records not tombstoned by a folded drop entry. */
	activeObservations: Observation[];
	/** Tombstoned observation ids, including ids that may not have a corresponding folded observation. */
	droppedObservationIds: Set<string>;
	/** All first-valid reflection records encountered through the fold boundary, including retired reflections. */
	reflections: Reflection[];
	/** Reflection records not tombstoned by a folded retirement entry. */
	activeReflections: Reflection[];
	/** Retired reflection ids, including ids that may not have a corresponding folded reflection. */
	retiredReflectionIds: Set<string>;
	/** Replacing reflection id per retired reflection id, for retirements that named one. */
	reflectionReplacedBy: Map<string, string>;
	/** Timestamp of the entry that first recorded each reflection id, when that entry has one. */
	reflectionRecordedAt: Map<string, string>;
	/** All first-valid observation records by id, including dropped observations. */
	observationsById: Map<string, Observation>;
	/** All first-valid reflection records by id, including retired reflections. */
	reflectionsById: Map<string, Reflection>;
};

function foldEndIndex(entries: Entry[], upToEntryId: string | undefined): number {
	if (!upToEntryId) return entries.length - 1;
	const idx = entries.findIndex((entry) => entry.id === upToEntryId);
	return idx === -1 ? entries.length - 1 : idx;
}

/** Retire each id; the first retirement that names a replacement wins. */
export function applyReflectionRetirement(
	reflectionIds: readonly string[],
	replacedBy: string | undefined,
	retiredReflectionIds: Set<string>,
	reflectionReplacedBy: Map<string, string>,
): void {
	for (const reflectionId of reflectionIds) {
		retiredReflectionIds.add(reflectionId);
		if (replacedBy && !reflectionReplacedBy.has(reflectionId)) reflectionReplacedBy.set(reflectionId, replacedBy);
	}
}

function isCustomEntry(entry: Entry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

/**
 * Fold valid V3 memory ledger entries from the branch root through the target entry.
 *
 * Unknown custom entries, old V2 entries, invalid V3-shaped data, and compaction details are ignored.
 * Observations and reflections use first-valid-record-wins semantics. Drops and reflection retirements
 * are tombstones and are retained even when the id is unknown at the time of folding; nothing un-retires.
 * The first retirement that names a replacement wins.
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();
	const retiredReflectionIds = new Set<string>();
	const reflectionReplacedBy = new Map<string, string>();
	const reflectionRecordedAt = new Map<string, string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) {
				if (!observationsById.has(observation.id)) {
					observationsById.set(observation.id, observation);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) {
					reflectionsById.set(reflection.id, reflection);
					if (entry.timestamp) reflectionRecordedAt.set(reflection.id, entry.timestamp);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const observationId of entry.data.observationIds) {
				droppedObservationIds.add(observationId);
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_DROPPED)) {
			if (!isReflectionsDroppedData(entry.data)) continue;
			applyReflectionRetirement(entry.data.reflectionIds, entry.data.replacedBy, retiredReflectionIds, reflectionReplacedBy);
		}
	}

	const observations = Array.from(observationsById.values());
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));
	const reflections = Array.from(reflectionsById.values());
	const activeReflections = reflections.filter((reflection) => !retiredReflectionIds.has(reflection.id));

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		activeReflections,
		retiredReflectionIds,
		reflectionReplacedBy,
		reflectionRecordedAt,
		observationsById,
		reflectionsById,
	};
}

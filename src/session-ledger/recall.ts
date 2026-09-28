import { applyReflectionRetirement, emptyReflectionRetirementState, reactivateRecordedReflections, type ReflectionRetirementState } from "./fold.js";
import {
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsDroppedEntry,
	isReflectionsRecordedEntry,
	type Entry,
	type Observation,
	type Reflection,
	type ReflectionRetirementKind,
} from "./types.js";

const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export type { Entry, Observation, Reflection };

type ObservationLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

type ReflectionLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

/** Ledger location fields are absent for records recalled from `.memory/`. */
export type RecalledObservation = {
	observation: Observation;
	observationEntryId?: string;
	observationRecordIndex?: number;
	status: "active" | "dropped";
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
};

export type RecalledReflection = {
	reflection: Reflection;
	reflectionEntryId?: string;
	reflectionRecordIndex?: number;
	status: "active" | "retired";
	/** Replacing reflection id recorded by the retirement, when known. */
	replacedBy?: string;
	/** Retirement kind, when the retirement named one. */
	retirementKind?: ReflectionRetirementKind;
	/** First-recorded reflections named by `reflection.replaces`. */
	replacedReflections: Reflection[];
	missingReplacedReflectionIds: string[];
};

export type RecallResult =
	| {
			status: "not_found";
			memoryId: string;
			kind: undefined;
			reflections: [];
			observations: [];
			sourceEntries: [];
			missingSourceEntryIds: [];
			nonSourceEntryIds: [];
			missingSupportingObservationIds: [];
			collision: false;
			partial: false;
	  }
	| {
			status: "found";
			memoryId: string;
			kind: "observation" | "reflection" | "mixed";
			reflections: RecalledReflection[];
			observations: RecalledObservation[];
			sourceEntries: Entry[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
			missingSupportingObservationIds: string[];
			collision: boolean;
			partial: boolean;
	  };

type IndexedObservation = ObservationLedgerLocation & { observation: Observation };
type IndexedReflection = ReflectionLedgerLocation & { reflection: Reflection };

function isSourceEntry(entry: Entry): boolean {
	return SOURCE_TYPES.has(entry.type);
}

function uniqueById(entries: Entry[]): Entry[] {
	const seen = new Set<string>();
	const result: Entry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		result.push(entry);
	}
	return result;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function indexLedger(entries: Entry[]): {
	observations: IndexedObservation[];
	reflections: IndexedReflection[];
	droppedIds: Set<string>;
	retirement: ReflectionRetirementState;
} {
	const observations: IndexedObservation[] = [];
	const reflections: IndexedReflection[] = [];
	const droppedIds = new Set<string>();
	const retirement = emptyReflectionRetirementState();

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		if (isObservationsRecordedEntry(entry)) {
			entry.data.observations.forEach((observation, recordIndex) => {
				observations.push({ observation, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isReflectionsRecordedEntry(entry)) {
			entry.data.reflections.forEach((reflection, recordIndex) => {
				reflections.push({ reflection, entryId: entry.id, entryIndex, recordIndex });
			});
			reactivateRecordedReflections(entry.data.reflections, retirement);
			continue;
		}
		if (isObservationsDroppedEntry(entry)) {
			entry.data.observationIds.forEach((id) => droppedIds.add(id));
			continue;
		}
		if (isReflectionsDroppedEntry(entry)) {
			applyReflectionRetirement(entry.data, retirement);
		}
	}

	return { observations, reflections, droppedIds, retirement };
}

/** Resolve an observation's source entries; `location` is its ledger position, absent for `.memory/` records. */
export function resolveObservationSources(entries: Entry[], observation: Observation, location?: ObservationLedgerLocation): RecalledObservation {
	const sourceEntryIds = uniqueStrings(observation.sourceEntryIds);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sourceEntries: Entry[] = [];
	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];

	for (const sourceEntryId of sourceEntryIds) {
		const sourceEntry = byId.get(sourceEntryId);
		if (!sourceEntry) {
			missingSourceEntryIds.push(sourceEntryId);
			continue;
		}
		if (!isSourceEntry(sourceEntry)) {
			nonSourceEntryIds.push(sourceEntryId);
			continue;
		}
		sourceEntries.push(sourceEntry);
	}

	return {
		observation,
		...(location ? { observationEntryId: location.entryId, observationRecordIndex: location.recordIndex } : {}),
		status: "active",
		sourceEntryIds,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
	};
}

function notFound(memoryId: string): RecallResult {
	return {
		status: "not_found",
		memoryId,
		kind: undefined,
		reflections: [],
		observations: [],
		sourceEntries: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		missingSupportingObservationIds: [],
		collision: false,
		partial: false,
	};
}

export function recallMemorySources(entries: Entry[], memoryId: string): RecallResult {
	const {
		observations: indexedObservations,
		reflections: indexedReflections,
		droppedIds,
		retirement: { retiredReflectionIds, reflectionReplacedBy, reflectionRetirementKind },
	} = indexLedger(entries);
	const directObservationMatches = indexedObservations.filter(({ observation }) => observation.id === memoryId);
	const reflectionMatches = indexedReflections.filter(({ reflection }) => reflection.id === memoryId);

	if (directObservationMatches.length === 0 && reflectionMatches.length === 0) return notFound(memoryId);

	const observationsById = new Map<string, IndexedObservation>();
	for (const indexed of indexedObservations) {
		if (!observationsById.has(indexed.observation.id)) observationsById.set(indexed.observation.id, indexed);
	}

	const recalledByKey = new Map<string, RecalledObservation>();
	const missingSupportingObservationIds: string[] = [];

	function addObservation(indexed: IndexedObservation): void {
		const key = `${indexed.entryId}:${indexed.recordIndex}`;
		if (recalledByKey.has(key)) return;
		const recalled = resolveObservationSources(entries, indexed.observation, indexed);
		recalled.status = droppedIds.has(indexed.observation.id) ? "dropped" : "active";
		recalledByKey.set(key, recalled);
	}

	for (const match of directObservationMatches) addObservation(match);

	for (const { reflection } of reflectionMatches) {
		for (const observationId of uniqueStrings(reflection.supportingObservationIds)) {
			const indexed = observationsById.get(observationId);
			if (!indexed) {
				missingSupportingObservationIds.push(observationId);
				continue;
			}
			addObservation(indexed);
		}
	}

	const recalledObservations = Array.from(recalledByKey.values());
	const reflectionsById = new Map<string, Reflection>();
	for (const { reflection } of indexedReflections) {
		if (!reflectionsById.has(reflection.id)) reflectionsById.set(reflection.id, reflection);
	}
	const recalledReflections: RecalledReflection[] = reflectionMatches.map(({ reflection, entryId, recordIndex }) => {
		const replacedIds = uniqueStrings(reflection.replaces ?? []);
		const replacedBy = reflectionReplacedBy.get(reflection.id);
		const retired = retiredReflectionIds.has(reflection.id);
		const retirementKind = retired ? reflectionRetirementKind.get(reflection.id) : undefined;
		return {
			reflection,
			reflectionEntryId: entryId,
			reflectionRecordIndex: recordIndex,
			status: retired ? "retired" : "active",
			...(replacedBy ? { replacedBy } : {}),
			...(retirementKind ? { retirementKind } : {}),
			replacedReflections: replacedIds.flatMap((id) => {
				const replaced = reflectionsById.get(id);
				return replaced ? [replaced] : [];
			}),
			missingReplacedReflectionIds: replacedIds.filter((id) => !reflectionsById.has(id)),
		};
	});
	const sourceEntries = uniqueById(recalledObservations.flatMap((match) => match.sourceEntries));
	const missingSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.missingSourceEntryIds));
	const nonSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.nonSourceEntryIds));
	const uniqueMissingSupportingObservationIds = uniqueStrings(missingSupportingObservationIds);
	const matchCount = directObservationMatches.length + reflectionMatches.length;

	return {
		status: "found",
		memoryId,
		kind: directObservationMatches.length > 0 && reflectionMatches.length > 0
			? "mixed"
			: reflectionMatches.length > 0
				? "reflection"
				: "observation",
		reflections: recalledReflections,
		observations: recalledObservations,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
		missingSupportingObservationIds: uniqueMissingSupportingObservationIds,
		collision: matchCount > 1,
		partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || uniqueMissingSupportingObservationIds.length > 0,
	};
}

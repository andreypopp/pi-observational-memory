import { describe, expect, it } from "vitest";

import {
	OM_FOLDED,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsDroppedData,
	buildReflectionsRecordedData,
	isMemoryDetails,
	isObservationsDroppedData,
	isObservationsDroppedEntry,
	isObservationsRecordedData,
	isObservationsRecordedEntry,
	isObservation,
	isReflection,
	isReflectionsDroppedData,
	isReflectionsDroppedEntry,
	isReflectionsRecordedData,
	isReflectionsRecordedEntry,
} from "../src/session-ledger/index.js";
import {
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
} from "./fixtures/session.js";

describe("session-ledger V3 type guards and builders", () => {
	it("exports the V3 custom type constants", () => {
		expect(OM_OBSERVATIONS_RECORDED).toBe("om.observations.recorded");
		expect(OM_REFLECTIONS_RECORDED).toBe("om.reflections.recorded");
		expect(OM_OBSERVATIONS_DROPPED).toBe("om.observations.dropped");
		expect(OM_REFLECTIONS_DROPPED).toBe("om.reflections.dropped");
		expect(OM_FOLDED).toBe("om.folded");
	});

	it("accepts valid V3 observation records and rejects observations without source ids", () => {
		expect(isObservation(observation("aaaaaaaaaaaa"))).toBe(true);
		expect(isObservation({ ...observation("bbbbbbbbbbbb"), sourceEntryIds: [] })).toBe(false);
		expect(isObservation({ ...observation("cccccccccccc"), sourceEntryIds: undefined })).toBe(false);
		expect(isObservation({ ...observation("dddddddddddd"), tokenCount: undefined })).toBe(false);
	});

	it("accepts valid V3 reflection records", () => {
		expect(isReflection(reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]))).toBe(true);
		expect(isReflection({ ...reflection("ffffffffffff"), supportingObservationIds: undefined })).toBe(false);
		expect(isReflection({ ...reflection("111111111111"), tokenCount: undefined })).toBe(false);
	});

	it("accepts non-empty V3 ledger entry data", () => {
		const obsData = { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" };
		const refData = { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" };
		const dropData = { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "ref-entry-1" };

		expect(isObservationsRecordedData(obsData)).toBe(true);
		expect(isReflectionsRecordedData(refData)).toBe(true);
		expect(isObservationsDroppedData(dropData)).toBe(true);
	});

	it("rejects empty ledger entry data so no empty progress entries can be appended", () => {
		expect(isObservationsRecordedData({ observations: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsRecordedData({ reflections: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isObservationsDroppedData({ observationIds: [], coversUpToId: "raw-1" })).toBe(false);
	});

	it("builders return undefined for empty arrays and data for non-empty arrays", () => {
		expect(buildObservationsRecordedData([], "raw-1")).toBeUndefined();
		expect(buildReflectionsRecordedData([], "raw-1")).toBeUndefined();
		expect(buildObservationsDroppedData([], "raw-1")).toBeUndefined();

		expect(buildObservationsRecordedData([observation("aaaaaaaaaaaa")], "raw-1")).toEqual({
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		});
		expect(buildReflectionsRecordedData([reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], "raw-1")).toEqual({
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			coversUpToId: "raw-1",
		});
		expect(buildObservationsDroppedData(["aaaaaaaaaaaa"], "ref-entry-1")).toEqual({
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "ref-entry-1",
		});
	});

	it("recognizes V3 memory entries", () => {
		expect(isObservationsRecordedEntry(observationsRecordedEntry("om-aaaaaaaaaaaa", {
			observations: [observation("aaaaaaaaaaaa")],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isReflectionsRecordedEntry(reflectionsRecordedEntry("om-eeeeeeeeeeee", {
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
			coversUpToId: "raw-1",
		}))).toBe(true);
		expect(isObservationsDroppedEntry(observationsDroppedEntry("om-drop-1", {
			observationIds: ["aaaaaaaaaaaa"],
			coversUpToId: "om-eeeeeeeeeeee",
		}))).toBe(true);
	});

	it("accepts flat V3 folded memory details", () => {
		expect(isMemoryDetails(memoryDetails({
			fullFold: true,
			observations: [observation("aaaaaaaaaaaa")],
			reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])],
		}))).toBe(true);
	});

	it("ignores old V2 observation entries and old V2 compaction details", () => {
		expect(isObservationsRecordedEntry(oldV2ObservationEntry("v2-entry"))).toBe(false);
		expect(isMemoryDetails(oldV2CompactionDetails())).toBe(false);
	});

	it("accepts reflections with valid replaces ids and keeps accepting reflections without them", () => {
		expect(isReflection(reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]))).toBe(true);
		expect(isReflection(reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { replaces: ["ffffffffffff"] }))).toBe(true);
		expect(isReflection({ ...reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]), replaces: [] })).toBe(false);
		expect(isReflection({ ...reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]), replaces: ["not-an-id"] })).toBe(false);
		expect(isReflection({ ...reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]), replaces: "ffffffffffff" })).toBe(false);
	});

	it("validates reflection retirement data", () => {
		expect(isReflectionsDroppedData({ reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-1" })).toBe(true);
		expect(isReflectionsDroppedData({ reflectionIds: ["eeeeeeeeeeee"], replacedBy: "ffffffffffff", coversUpToId: "raw-1" })).toBe(true);
		expect(isReflectionsDroppedData({ reflectionIds: [], coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: ["not-an-id"], coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: ["eeeeeeeeeeee"], replacedBy: "nope", coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: ["eeeeeeeeeeee"], replacedBy: "eeeeeeeeeeee", coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "" })).toBe(false);
		expect(isReflectionsDroppedEntry(reflectionsDroppedEntry("om-retire-1", {
			reflectionIds: ["eeeeeeeeeeee"],
			coversUpToId: "raw-1",
		}))).toBe(true);
	});

	it("builds reflection retirement data and rejects empty ids or coverage", () => {
		expect(buildReflectionsDroppedData([], "raw-1")).toBeUndefined();
		expect(buildReflectionsDroppedData(["eeeeeeeeeeee"], "")).toBeUndefined();
		expect(buildReflectionsDroppedData(["not-an-id"], "raw-1")).toBeUndefined();
		expect(buildReflectionsDroppedData(["eeeeeeeeeeee"], "raw-1", "eeeeeeeeeeee")).toBeUndefined();
		expect(buildReflectionsDroppedData(["eeeeeeeeeeee"], "raw-1")).toEqual({
			reflectionIds: ["eeeeeeeeeeee"],
			coversUpToId: "raw-1",
		});
		expect(buildReflectionsDroppedData(["eeeeeeeeeeee"], "raw-1", "ffffffffffff")).toEqual({
			reflectionIds: ["eeeeeeeeeeee"],
			replacedBy: "ffffffffffff",
			coversUpToId: "raw-1",
		});
	});
});

import { describe, expect, it } from "vitest";

import {
	buildCompactionProjection,
	diffProjection,
	fullProjection,
	latestFullFoldBoundaryId,
	visibleProjection,
} from "../src/session-ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("session-ledger V3 projections", () => {
	it("full projection folds observations, reflections, and drops through the target", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const obs2 = observation("bbbbbbbbbbbb");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-eeeeeeeeeeee" }),
		];

		const projection = fullProjection(entries);

		expect(projection.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(projection.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});

	it("visible projection is empty when there is no V3 compaction", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("visible projection uses the latest valid om.folded compaction details", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const obs2 = observation("bbbbbbbbbbbb");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obs1], reflections: [] }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: true, observations: [obs2], reflections: [ref1] }) }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [obs2], reflections: [ref1] });
	});

	it("ignores old V2 compaction details for visible projection", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];

		expect(visibleProjection(entries)).toEqual({ observations: [], reflections: [] });
	});

	it("finds the latest full-fold boundary", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true }) }),
			textCustomMessage("raw-2", "bbbb"),
			compactionEntry("cmp-2", { firstKeptEntryId: "raw-2", details: memoryDetails({ fullFold: false }) }),
			textCustomMessage("raw-3", "cccc"),
			compactionEntry("cmp-3", { firstKeptEntryId: "raw-3", details: memoryDetails({ fullFold: true }) }),
		];

		expect(latestFullFoldBoundaryId(entries)).toBe("raw-3");
	});

	it("first normal compaction includes observations by coverage and excludes maintenance streams", () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.reflections).toEqual([]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
	});

	it("normal compaction projection includes current observations but keeps reflections and drops at latest full-fold boundary", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.observations.map((obs) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
	});

	it("full compaction projection applies reflections and drops through current boundary by coverage", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(true);
		expect(result.observations.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.reflections.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
		expect(result.details).toMatchObject({ type: "om.folded", version: 1, fullFold: true });
	});

	it("ignores dangling coversUpToId markers during projection", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "missing" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "missing" }),
			observationsDroppedEntry("om-drop-1", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "missing" }),
		];

		expect(() => fullProjection(entries, "raw-1")).not.toThrow();
		expect(fullProjection(entries, "raw-1")).toEqual({ observations: [], reflections: [] });
	});

	it("keeps the first covered observation and reflection for duplicate ids", () => {
		const firstObs = observation("aaaaaaaaaaaa", { content: "first observation" });
		const secondObs = observation("aaaaaaaaaaaa", { content: "second observation" });
		const firstRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "first reflection" });
		const secondRef = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "second reflection" });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [firstObs], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-obs-2", { observations: [secondObs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [firstRef], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-2", { reflections: [secondRef], coversUpToId: "raw-1" }),
		];

		const projection = fullProjection(entries, "raw-1");

		expect(projection.observations).toEqual([firstObs]);
		expect(projection.reflections).toEqual([firstRef]);
	});

	it("uses >= observationsPoolMaxTokens for full-fold pressure", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 50 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
		];

		expect(buildCompactionProjection(entries, "raw-1", { observationsPoolMaxTokens: 50 }).fullFold).toBe(true);
	});

	it("reports visible/full drift", () => {
		const visible = { observations: [observation("aaaaaaaaaaaa")], reflections: [] };
		const full = {
			observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")],
			reflections: [reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"])],
		};

		const diff = diffProjection(visible, full);

		expect(diff.observationsOnlyInFull.map((obs) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(diff.reflectionsOnlyInFull.map((ref) => ref.id)).toEqual(["eeeeeeeeeeee"]);
	});

	it("full projection excludes reflections retired through the boundary", () => {
		const obs1 = observation("aaaaaaaaaaaa");
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["aaaaaaaaaaaa"], { replaces: ["eeeeeeeeeeee"] });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			reflectionsRecordedEntry("om-ref-2", { reflections: [ref2], coversUpToId: "raw-2" }),
			reflectionsDroppedEntry("om-retire-1", { reflectionIds: ["eeeeeeeeeeee"], replacedBy: "ffffffffffff", coversUpToId: "raw-2" }),
		];

		expect(fullProjection(entries).reflections).toEqual([ref2]);
		expect(fullProjection(entries, "raw-1").reflections).toEqual([ref1]);
	});

	it("retirement tombstones apply to reflections covered after the retirement entry", () => {
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsDroppedEntry("om-retire-1", { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1], coversUpToId: "raw-1" }),
		];

		expect(fullProjection(entries).reflections).toEqual([]);
	});

	it("normal compaction keeps retirements frozen at the latest full-fold boundary until the next full fold", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1, ref2], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-retire-1", { reflectionIds: ["ffffffffffff"], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-obs-2", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsDroppedEntry("om-retire-2", { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-2" }),
		];

		const normal = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });
		expect(normal.fullFold).toBe(false);
		expect(normal.reflections).toEqual([ref1]);
		expect(normal.details.reflections).toEqual([ref1]);

		const full = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 10 });
		expect(full.fullFold).toBe(true);
		expect(full.reflections).toEqual([]);
		expect(full.details.reflections).toEqual([]);
	});

	it("retirement alone does not force a full fold", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			reflectionsDroppedEntry("om-retire-1", { reflectionIds: ["eeeeeeeeeeee"], coversUpToId: "raw-2" }),
		];

		const result = buildCompactionProjection(entries, "raw-2", { observationsPoolMaxTokens: 100 });

		expect(result.fullFold).toBe(false);
		expect(result.reflections).toEqual([ref1]);
	});

	it("reports reflections retired in full memory but still visible as drift", () => {
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		const visible = { observations: [], reflections: [ref1, ref2] };
		const full = { observations: [], reflections: [ref2] };

		expect(diffProjection(visible, full).reflectionsRetiredOnlyInFull).toEqual([ref1]);
	});

	it("projects sessions without retirement entries exactly as before", () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1], coversUpToId: "raw-1" }),
		];

		expect(fullProjection(entries)).toEqual({ observations: [obs1], reflections: [ref1] });
		expect(buildCompactionProjection(entries, "raw-1", { observationsPoolMaxTokens: 5 })).toEqual({
			fullFold: true,
			observations: [obs1],
			reflections: [ref1],
			details: { type: "om.folded", version: 1, fullFold: true, observations: [obs1], reflections: [ref1] },
		});
	});
});

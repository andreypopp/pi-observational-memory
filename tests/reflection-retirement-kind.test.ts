import { describe, expect, it } from "vitest";

import {
	buildCompactionProjection,
	buildReflectionsDroppedData,
	foldLedger,
	fullProjection,
	isReflectionsDroppedData,
	recallMemorySources,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

const REF_A = "aaaaaaaaaaa1";
const REF_B = "aaaaaaaaaaa2";
const REF_C = "aaaaaaaaaaa3";

describe("reflection retirement kind", () => {
	it("round-trips a valid kind through the guard and builder, and omits it when absent", () => {
		expect(buildReflectionsDroppedData([REF_A], "raw-1", undefined, "project-instructions")).toEqual({
			reflectionIds: [REF_A],
			kind: "project-instructions",
			coversUpToId: "raw-1",
		});
		expect(JSON.stringify(buildReflectionsDroppedData([REF_A], "raw-1"))).toBe(`{"reflectionIds":["${REF_A}"],"coversUpToId":"raw-1"}`);
		expect(JSON.stringify(buildReflectionsDroppedData([REF_A], "raw-1", REF_B))).toBe(`{"reflectionIds":["${REF_A}"],"replacedBy":"${REF_B}","coversUpToId":"raw-1"}`);
		for (const kind of ["stale", "duplicate", "project-instructions"]) {
			expect(isReflectionsDroppedData({ reflectionIds: [REF_A], kind, coversUpToId: "raw-1" })).toBe(true);
		}
	});

	it("rejects an invalid kind, and a kind on a replacement", () => {
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], kind: "obsolete", coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], kind: 3, coversUpToId: "raw-1" })).toBe(false);
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], replacedBy: REF_B, kind: "stale", coversUpToId: "raw-1" })).toBe(false);
	});

	function ledger(extra: ReturnType<typeof reflectionsRecordedEntry>[] = []) {
		return [
			textCustomMessage("raw-1", "a".repeat(40)),
			observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection(REF_A, ["bbbbbbbbbbbb"]), reflection(REF_B, ["bbbbbbbbbbbb"])], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ret-pi", { reflectionIds: [REF_A], kind: "project-instructions", coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ret-stale", { reflectionIds: [REF_B], kind: "stale", coversUpToId: "raw-1" }),
			...extra,
		];
	}

	it("records the kind per retired id in the fold", () => {
		const folded = foldLedger(ledger());

		expect(folded.activeReflections).toEqual([]);
		expect(folded.reflectionRetirementKind).toEqual(new Map([[REF_A, "project-instructions"], [REF_B, "stale"]]));
	});

	it("re-activates only project-instructions retirements when a later entry records the id again", () => {
		const entries = ledger([
			reflectionsRecordedEntry("om-ref-again", { reflections: [reflection(REF_A, ["bbbbbbbbbbbb"]), reflection(REF_B, ["bbbbbbbbbbbb"])], coversUpToId: "raw-1" }),
		]);
		const folded = foldLedger(entries);

		expect(folded.activeReflections.map((r) => r.id)).toEqual([REF_A]);
		expect(folded.retiredReflectionIds).toEqual(new Set([REF_B]));
		expect(folded.reflectionRetirementKind.has(REF_A)).toBe(false);
		expect(fullProjection(entries).reflections.map((r) => r.id)).toEqual([REF_A]);
		expect(buildCompactionProjection(entries, "om-ref-again", { observationsPoolMaxTokens: 1, forceFullFold: true }).reflections.map((r) => r.id)).toEqual([REF_A]);
		const recalled = recallMemorySources(entries as any, REF_A);
		expect(recalled.status === "found" && recalled.reflections.every((r) => r.status === "active")).toBe(true);
	});

	it("does not re-activate a recording that precedes the retirement", () => {
		const entries = ledger();
		expect(foldLedger(entries).activeReflections).toEqual([]);
		expect(fullProjection(entries).reflections).toEqual([]);
	});

	it("never downgrades a permanent retirement to a reversible one", () => {
		const entries = ledger([
			reflectionsDroppedEntry("om-ret-again", { reflectionIds: [REF_B], kind: "project-instructions", coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-again", { reflections: [reflection(REF_B, ["bbbbbbbbbbbb"])], coversUpToId: "raw-1" }),
		]);

		expect(foldLedger(entries).retiredReflectionIds.has(REF_B)).toBe(true);
	});

	it("reports the retirement kind in recall, and none for kindless retirements", () => {
		const entries = [
			...ledger(),
			reflectionsRecordedEntry("om-ref-c", { reflections: [reflection(REF_C, ["bbbbbbbbbbbb"])], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-ret-c", { reflectionIds: [REF_C], coversUpToId: "raw-1" }),
		];
		const a = recallMemorySources(entries as any, REF_A);
		const c = recallMemorySources(entries as any, REF_C);

		expect(a.status === "found" && a.reflections[0]).toMatchObject({ status: "retired", retirementKind: "project-instructions" });
		expect(c.status === "found" && c.reflections[0]).toMatchObject({ status: "retired" });
		expect(c.status === "found" && c.reflections[0]).not.toHaveProperty("retirementKind");
	});

	it("ignores retirements with the removed \"promoted\" kind, so those reflections stay active", () => {
		const entries = [
			textCustomMessage("raw-1", "a".repeat(40)),
			observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [reflection(REF_A, ["bbbbbbbbbbbb"]), reflection(REF_B, ["bbbbbbbbbbbb"])], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-promoted", { reflectionIds: [REF_A, REF_B], kind: "promoted", coversUpToId: "raw-1" }),
		];
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], kind: "promoted", coversUpToId: "raw-1" })).toBe(false);

		const folded = foldLedger(entries);
		expect(folded.activeReflections.map((r) => r.id)).toEqual([REF_A, REF_B]);
		expect(folded.retiredReflectionIds.size).toBe(0);
		expect(folded.reflectionRetirementKind.size).toBe(0);
		expect(fullProjection(entries).reflections.map((r) => r.id)).toEqual([REF_A, REF_B]);
		const recalled = recallMemorySources(entries as any, REF_A);
		expect(recalled.status === "found" && recalled.reflections[0]).toMatchObject({ status: "active" });
		expect(recalled.status === "found" && recalled.reflections[0]).not.toHaveProperty("retirementKind");
	});
});

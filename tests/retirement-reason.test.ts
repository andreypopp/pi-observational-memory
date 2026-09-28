import { describe, expect, it, vi } from "vitest";

import { formatRecallRenderedResultForTui, recallObservationTool } from "../src/tools/recall-observation.js";
import {
	buildCompactionProjection,
	buildReflectionsDroppedData,
	foldLedger,
	isReflectionsDroppedData,
	recallMemorySources,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
} from "./fixtures/session.js";

const REF_A = "aaaaaaaaaaa1";
const REF_B = "aaaaaaaaaaa2";

function ledger(reason: string | undefined) {
	return [
		rawMessage("raw-1", "evidence"),
		observationsRecordedEntry("om-obs", { observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-1"] })], coversUpToId: "raw-1" }),
		reflectionsRecordedEntry("om-ref", { reflections: [reflection(REF_A, ["bbbbbbbbbbbb"], { content: "Config lives in foo.json." })], coversUpToId: "raw-1" }),
		reflectionsDroppedEntry("om-drop", {
			reflectionIds: [REF_A],
			kind: "stale",
			...(reason !== undefined ? { reason } : {}),
			coversUpToId: "raw-1",
		} as any),
	];
}

describe("retirement reason", () => {
	it("is added by the builder only when present, on plain retirements and replacements", () => {
		expect(JSON.stringify(buildReflectionsDroppedData([REF_A], "raw-1", undefined, "stale"))).toBe(
			`{"reflectionIds":["${REF_A}"],"kind":"stale","coversUpToId":"raw-1"}`,
		);
		expect(JSON.stringify(buildReflectionsDroppedData([REF_A], "raw-1", undefined, "stale", "src/config.ts:12 reads bar.json"))).toBe(
			`{"reflectionIds":["${REF_A}"],"kind":"stale","reason":"src/config.ts:12 reads bar.json","coversUpToId":"raw-1"}`,
		);
		expect(buildReflectionsDroppedData([REF_A], "raw-1", REF_B, undefined, "renamed")).toEqual({
			reflectionIds: [REF_A],
			replacedBy: REF_B,
			reason: "renamed",
			coversUpToId: "raw-1",
		});
		expect(JSON.stringify(buildReflectionsDroppedData([REF_A], "raw-1", undefined, "stale", "  "))).not.toContain("reason");
	});

	it("is accepted by the validator only as a string", () => {
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], kind: "stale", reason: "gone", coversUpToId: "raw-1" })).toBe(true);
		expect(isReflectionsDroppedData({ reflectionIds: [REF_A], reason: 3, coversUpToId: "raw-1" })).toBe(false);
	});

	it("does not change the fold or projections", () => {
		const withReason = ledger("src/config.ts:12 reads bar.json");
		const without = ledger(undefined);

		expect(foldLedger(withReason)).toEqual(foldLedger(without));
		expect(buildCompactionProjection(withReason, "om-drop", { forceFullFold: true })).toEqual(
			buildCompactionProjection(without, "om-drop", { forceFullFold: true }),
		);
	});

	it("is shown by recall, and absent without one", async () => {
		const recalled = recallMemorySources(ledger("src/config.ts:12 reads bar.json"), REF_A);
		expect(recalled.status === "found" && recalled.reflections[0]).toMatchObject({ retirementKind: "stale", retirementReason: "src/config.ts:12 reads bar.json" });
		const plain = recallMemorySources(ledger(undefined), REF_A);
		expect(plain.status === "found" && "retirementReason" in plain.reflections[0]).toBe(false);

		const tool = recallObservationTool;
		const ctx = { sessionManager: { getBranch: vi.fn(() => ledger("src/config.ts:12 reads bar.json")) } };
		const result = await tool.execute("call-1", { id: REF_A }, undefined as any, undefined as any, ctx as any);
		const text = result.content.map((part: any) => part.text).join("\n");
		expect(text).toContain(`Reflection ${REF_A} is retired (stale) from active memory but remains recallable. Reason: src/config.ts:12 reads bar.json`);
		expect(formatRecallRenderedResultForTui(result as any, false)).toContain("reason: src/config.ts:12 reads bar.json");

		const plainResult = await tool.execute("call-2", { id: REF_A }, undefined as any, undefined as any, { sessionManager: { getBranch: () => ledger(undefined) } } as any);
		expect(plainResult.content.map((part: any) => part.text).join("\n")).not.toContain("Reason");
	});
});

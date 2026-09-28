import { describe, expect, it } from "vitest";

import { runReflectionReview } from "../src/agents/reviewer/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { observation, reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

const OLD_A = reflection("aaaaaaaaaaa1", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], { content: "Old fact A" });
const OLD_B = reflection("aaaaaaaaaaa2", ["bbbbbbbbbbbb", "cccccccccccc"], { content: "Old fact B" });
const NEW_C = reflection("aaaaaaaaaaa3", ["dddddddddddd"], { content: "New fact C" });

function baseArgs(overrides: Record<string, unknown> = {}) {
	return {
		model: {} as any,
		apiKey: "test",
		reflections: [OLD_A, OLD_B, NEW_C],
		newReflectionIds: new Set([NEW_C.id]),
		retiredReflectionIds: new Set<string>(),
		recordedAt: new Map([
			[OLD_A.id, "2026-05-01 09:00"],
			[OLD_B.id, "2026-05-01 10:00"],
			[NEW_C.id, "2026-05-02 11:00"],
		]),
		observations: [observation("dddddddddddd", { content: "Recent evidence" })],
		...overrides,
	};
}

/** Runs the review with one scripted sequence of tool calls, returning the result and each tool reply text. */
async function review(calls: unknown[], overrides: Record<string, unknown> = {}) {
	const replies: string[] = [];
	const loop = fakeAgentLoop(async (_prompts, context) => {
		for (const call of calls) {
			const reply = await context.tools[0].execute("tool-1", call);
			replies.push(reply.content[0].text);
		}
	});
	const result = await runReflectionReview({ ...baseArgs(overrides), agentLoop: loop });
	return { result, replies };
}

describe("reflection review agent", () => {
	it("renders active reflections with record times, [new] markers, and observations as evidence", async () => {
		let userText = "";
		let systemPrompt = "";
		const loop = fakeAgentLoop((prompts, context) => {
			userText = prompts[0].content[0].text;
			systemPrompt = context.messages[0]?.content ?? "";
		});

		await runReflectionReview({ ...baseArgs(), agentLoop: loop });

		expect(userText).toContain("[aaaaaaaaaaa1] (recorded 2026-05-01 09:00) Old fact A");
		expect(userText).toContain("[aaaaaaaaaaa3] (recorded 2026-05-02 11:00) [new] New fact C");
		expect(userText).toContain("RECENT OBSERVATIONS:");
		expect(userText).toContain("Recent evidence");
		expect(systemPrompt).toContain("tidy_reflections");
		expect(systemPrompt).toContain("[new]");
		expect(systemPrompt).toContain("never \"this supersedes\"");
		expect(systemPrompt).toContain("Never invent");
	});

	it("returns undefined when the model changes nothing", async () => {
		const { result } = await review([]);
		expect(result).toBeUndefined();
	});

	it("retires known active reflections and groups plain retirements", async () => {
		const { result, replies } = await review([{ retire: [{ id: OLD_A.id, reason: "stale" }, { id: OLD_B.id, reason: "stale" }] }]);

		expect(result).toEqual({ replacements: [], retirements: [{ reflectionIds: [OLD_A.id, OLD_B.id] }] });
		expect(replies[0]).toContain("Retired 2");
	});

	it("rejects unknown ids, ids decided twice, and retiring [new] reflections outright", async () => {
		const { result, replies } = await review([
			{ retire: [{ id: "ffffffffffff", reason: "x" }, { id: OLD_A.id, reason: "x" }, { id: NEW_C.id, reason: "x" }] },
			{ retire: [{ id: OLD_A.id, reason: "again" }] },
			{ replace: [{ content: "Merged", replacesIds: [OLD_A.id], reason: "again" }] },
		]);

		expect(replies[0]).toContain("ffffffffffff is not an active reflection");
		expect(replies[0]).toContain(`${NEW_C.id} is [new]`);
		expect(replies[1]).toContain(`${OLD_A.id} was already decided`);
		expect(replies[2]).toContain(`${OLD_A.id} was already decided`);
		expect(result).toEqual({ replacements: [], retirements: [{ reflectionIds: [OLD_A.id] }] });
	});

	it("replaces reflections with one reflection whose support is the union of the replaced support", async () => {
		const content = "Merged durable fact";
		const { result } = await review([{ replace: [{ content: `  ${content}  `, replacesIds: [OLD_A.id, NEW_C.id, OLD_B.id], reason: "merge" }] }]);
		const id = hashId(content);

		expect(result).toEqual({
			replacements: [{
				id,
				content,
				supportingObservationIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "dddddddddddd", "cccccccccccc"],
				tokenCount: estimateStringTokens(content),
				replaces: [OLD_A.id, NEW_C.id, OLD_B.id],
			}],
			retirements: [{ reflectionIds: [OLD_A.id, NEW_C.id, OLD_B.id], replacedBy: id }],
		});
	});

	it("rejects multi-line or empty replacement content", async () => {
		const { result, replies } = await review([
			{ replace: [{ content: "Two\nlines", replacesIds: [OLD_A.id], reason: "x" }] },
			{ replace: [{ content: "   ", replacesIds: [OLD_A.id], reason: "x" }] },
		]);

		expect(replies[0]).toContain("single line");
		expect(replies[1]).toContain("single line");
		expect(result).toBeUndefined();
	});

	it("rejects a replacement whose content hashes to a retired reflection or to one it replaces", async () => {
		const retiredContent = "Previously retired fact";
		const { result, replies } = await review([
			{ replace: [{ content: retiredContent, replacesIds: [OLD_A.id], reason: "x" }] },
			{ replace: [{ content: OLD_B.content, replacesIds: [hashId(OLD_B.content)], reason: "x" }] },
		], {
			retiredReflectionIds: new Set([hashId(retiredContent)]),
			reflections: [OLD_A, { ...OLD_B, id: hashId(OLD_B.content) }, NEW_C],
		});

		expect(replies[0]).toContain("reword");
		expect(replies[1]).toContain("reword");
		expect(result).toBeUndefined();
	});

	it("retires replaced ids in favor of an existing active reflection with the same content", async () => {
		const existing = { ...OLD_B, id: hashId(OLD_B.content) };
		const { result, replies } = await review([
			{ replace: [{ content: OLD_B.content, replacesIds: [OLD_A.id], reason: "duplicate" }] },
			{ retire: [{ id: existing.id, reason: "x" }] },
		], { reflections: [OLD_A, existing, NEW_C] });

		expect(result).toEqual({ replacements: [], retirements: [{ reflectionIds: [OLD_A.id], replacedBy: existing.id }] });
		expect(replies[1]).toContain(`${existing.id} was already decided`);
	});

	it("rejects replacement ids that are not active reflections", async () => {
		const { result, replies } = await review([{ replace: [{ content: "Merged", replacesIds: [OLD_A.id, "ffffffffffff"], reason: "x" }] }]);

		expect(replies[0]).toContain("ffffffffffff is not an active reflection");
		expect(result).toBeUndefined();
	});

	it("uses finishTurn as a turn cap without overriding hard exits", async () => {
		let config: any;
		const loop = fakeAgentLoop((_prompts, _context, loopConfig) => {
			config = loopConfig;
		});

		await runReflectionReview({ ...baseArgs(), agentLoop: loop, maxTurns: 1, model: { maxTokens: 8_192 } as any, maxOutputTokens: 32_000 });

		expect(config.maxTokens).toBe(8_192);
		expect(config.finishTurn({ message: { stopReason: "error" } })).toBeUndefined();
		expect(config.finishTurn({ message: { stopReason: "stop" } })).toEqual({ action: "end" });
	});

	describe("project context", () => {
		const PROJECT = "PROJECT INSTRUCTIONS (loaded into every session of this project; reference only):\n\n### /repo/AGENTS.md\nRun npm test.";

		it("opens the user message with the project context and is unchanged without it", async () => {
			const texts: string[] = [];
			const loop = fakeAgentLoop((prompts) => {
				texts.push(prompts[0].content[0].text);
			});

			await runReflectionReview({ ...baseArgs(), projectContext: PROJECT, agentLoop: loop });
			await runReflectionReview({ ...baseArgs(), agentLoop: loop });
			await runReflectionReview({ ...baseArgs(), projectContext: "", agentLoop: loop });

			expect(texts[0]).toBe(`${PROJECT}\n\n${texts[1]}`);
			expect(texts[1].startsWith("CURRENT REFLECTIONS:\n")).toBe(true);
			expect(texts[2]).toBe(texts[1]);
		});

		it("tells the model to retire reflections covered by project instructions with that kind", async () => {
			let systemPrompt = "";
			await runReflectionReview({ ...baseArgs(), agentLoop: fakeAgentLoop((_prompts, context) => {
				systemPrompt = context.messages[0]?.content ?? "";
			}) });

			expect(systemPrompt).toContain("\"project-instructions\"");
			expect(systemPrompt).toContain("adds to, corrects, or contradicts PROJECT INSTRUCTIONS must be kept");
		});

		it("retires a [new] reflection outright only as covered by project instructions", async () => {
			const { result, replies } = await review([
				{ retire: [{ id: NEW_C.id, kind: "stale", reason: "old" }] },
				{ retire: [{ id: NEW_C.id, kind: "project-instructions", reason: "AGENTS.md says it" }] },
			]);

			expect(replies[0]).toContain(`${NEW_C.id} is [new] and can be retired outright only as covered by project instructions`);
			expect(result?.retirements).toEqual([{ reflectionIds: [NEW_C.id], kind: "project-instructions" }]);
		});

		it("groups plain retirements by kind in first-seen order", async () => {
			const { result } = await review([{
				retire: [
					{ id: OLD_A.id, kind: "project-instructions", reason: "covered" },
					{ id: OLD_B.id, kind: "duplicate", reason: "dup" },
				],
			}]);

			expect(result?.retirements).toEqual([
				{ reflectionIds: [OLD_A.id], kind: "project-instructions" },
				{ reflectionIds: [OLD_B.id], kind: "duplicate" },
			]);
		});
	});
});

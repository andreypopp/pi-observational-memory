import { describe, expect, it } from "vitest";

import { runPromoter, validatePromotedBlock } from "../src/agents/promoter/agent.js";
import { hashId } from "../src/ids.js";
import { blockTokens, renderBlockLine, type BlockLine } from "../src/project-memory/memory-file.js";
import { reflection } from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any) => Promise<void> | void, events: any[] = []): any {
	return ((prompts: any[], context: any) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => {
			await handler(prompts, context);
			return {};
		},
	})) as any;
}

const REF_A = reflection(hashId("Fact A"), ["aaaaaaaaaaaa"], { content: "Fact A" });
const REF_B = reflection(hashId("Fact B"), ["bbbbbbbbbbbb"], { content: "Fact B" });
const BLOCK_ID = "cccccccccccc";
const BLOCK: BlockLine[] = [
	{ id: BLOCK_ID, content: "Old block fact", raw: renderBlockLine(BLOCK_ID, "Old block fact"), hasId: true },
	{ id: hashId("Hand line"), content: "Hand line", raw: "- Hand line", hasId: false },
];

function args(overrides: Record<string, unknown> = {}) {
	return {
		blockLines: BLOCK,
		blockRecords: new Map([[BLOCK_ID, { id: BLOCK_ID, content: "Old block fact", supportingObservationIds: ["dddddddddddd"] }]]),
		activeReflections: [REF_A, REF_B],
		retiredReflectionIds: new Set<string>(["eeeeeeeeeeee"]),
		maxBlockTokens: 1500,
		...overrides,
	};
}

describe("set_promoted_block validation", () => {
	it("keeps lines, promotes unchanged reflections under their own id, and rewrites merged lines", () => {
		const merged = "Merged fact from A and the old line";
		const result = validatePromotedBlock({
			lines: [
				{ keepId: hashId("Hand line") },
				{ content: "Fact B", fromIds: [REF_B.id] },
				{ content: ` ${merged} `, fromIds: [REF_A.id, BLOCK_ID] },
			],
		}, args());

		expect(result).toEqual({
			lines: [
				{ kind: "keep", id: hashId("Hand line"), line: "- Hand line" },
				{ kind: "promote", id: REF_B.id, line: renderBlockLine(REF_B.id, "Fact B"), reflection: REF_B },
				{
					kind: "rewrite",
					id: hashId(merged),
					line: renderBlockLine(hashId(merged), merged),
					content: merged,
					fromIds: [REF_A.id, BLOCK_ID],
					replaces: [REF_A.id, BLOCK_ID],
					supportingObservationIds: ["aaaaaaaaaaaa", "dddddddddddd"],
				},
			],
			tokens: blockTokens(["- Hand line", renderBlockLine(REF_B.id, "Fact B"), renderBlockLine(hashId(merged), merged)]),
		});
	});

	it("treats an unchanged block line given as content as kept", () => {
		const result = validatePromotedBlock({ lines: [{ content: "Old block fact", fromIds: [BLOCK_ID] }] }, args());
		expect(result).toMatchObject({ lines: [{ kind: "keep", id: BLOCK_ID, line: renderBlockLine(BLOCK_ID, "Old block fact") }] });
	});

	it.each([
		[{ lines: [{ keepId: "ffffffffffff" }] }, "is not an existing block line"],
		[{ lines: [{ keepId: BLOCK_ID, content: "x", fromIds: [REF_A.id] }] }, "either keepId or content"],
		[{ lines: [{ content: "x", fromIds: ["ffffffffffff"] }] }, "is not an active reflection or block line"],
		[{ lines: [{ content: "x", fromIds: [] }] }, "fromIds must name"],
		[{ lines: [{ content: "two\nlines", fromIds: [REF_A.id] }] }, "non-empty single line"],
		[{ lines: [{ content: "  ", fromIds: [REF_A.id] }] }, "non-empty single line"],
		[{ lines: [{ keepId: BLOCK_ID }, { content: "Other", fromIds: [BLOCK_ID] }] }, "used more than once"],
		[{ lines: [{ content: "Fact B", fromIds: [REF_A.id] }] }, `matches ${REF_B.id}`],
		[{ lines: [{ content: "Hand line", fromIds: [REF_A.id] }] }, `matches ${hashId("Hand line")}`],
		[{ lines: [{ content: "Reworded hand line", fromIds: [hashId("Hand line")] }] }, "has recorded evidence"],
		[{ lines: [{ content: "Same", fromIds: [REF_A.id] }, { content: "Same", fromIds: [REF_B.id] }] }, "already has id"],
	])("rejects %j", (params, problem) => {
		const result = validatePromotedBlock(params as any, args());
		expect("problems" in result && result.problems.join("; ")).toContain(problem);
	});

	it("rejects a rewrite that collides with a retired id", () => {
		const retired = new Set([hashId("Reused")]);
		const result = validatePromotedBlock({ lines: [{ content: "Reused", fromIds: [REF_A.id] }] }, args({ retiredReflectionIds: retired }));
		expect("problems" in result && result.problems[0]).toContain("retired or replaced");
	});

	it("rejects a block over the budget", () => {
		const result = validatePromotedBlock({ lines: [{ content: "Fact A", fromIds: [REF_A.id] }] }, args({ maxBlockTokens: 10 }));
		expect("problems" in result && result.problems[0]).toContain("over the budget of 10");
	});
});

describe("runPromoter", () => {
	it("renders block lines, reflections with record times, project context and budget; the last accepted call wins", async () => {
		let userText = "";
		let system = "";
		const replies: string[] = [];
		const loop = fakeAgentLoop(async (prompts, context) => {
			userText = prompts[0].content[0].text;
			system = context.messages[0].content;
			for (const call of [{ lines: [{ keepId: "ffffffffffff" }] }, { lines: [{ keepId: BLOCK_ID }] }, { lines: [{ content: "Fact A", fromIds: [REF_A.id] }] }]) {
				replies.push((await context.tools[0].execute("t", call)).content[0].text);
			}
		});

		const result = await runPromoter({
			...args(),
			model: {} as any,
			recordedAt: new Map([[REF_A.id, "2026-09-01 10:00"]]),
			projectContext: "PROJECT INSTRUCTIONS (x):\n\n### /repo/AGENTS.md\nRules.",
			agentLoop: loop,
		});

		expect(userText.startsWith("PROJECT INSTRUCTIONS")).toBe(true);
		expect(userText).toContain(`PROMOTED BLOCK:\n[${BLOCK_ID}] Old block fact\n[${hashId("Hand line")}] Hand line`);
		expect(userText).toContain(`[${REF_A.id}] (recorded 2026-09-01 10:00) Fact A`);
		expect(userText).toContain("BLOCK BUDGET: 1500");
		expect(system).toContain("set_promoted_block");
		expect(replies[0]).toContain("Rejected");
		expect(replies[1]).toContain("Accepted: 1 lines");
		expect(result?.lines.map((line) => line.id)).toEqual([REF_A.id]);
	});

	it("returns undefined without a tool call, and throws when the call failed", async () => {
		expect(await runPromoter({ ...args(), model: {} as any, recordedAt: new Map(), agentLoop: fakeAgentLoop(() => undefined) })).toBeUndefined();
		const failed = [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } }];
		await expect(runPromoter({ ...args(), model: {} as any, recordedAt: new Map(), agentLoop: fakeAgentLoop(() => undefined, failed) })).rejects.toThrow("rate limited");
	});

	it("puts the instructions into the user message on claude-bridge models", async () => {
		let prompts: any[] = [];
		let messages: any[] = [];
		await runPromoter({
			...args(),
			model: { baseUrl: "claude-bridge" } as any,
			recordedAt: new Map(),
			agentLoop: fakeAgentLoop((p, context) => {
				prompts = p;
				messages = context.messages;
			}),
		});
		expect(messages).toEqual([]);
		expect(prompts[0].content[0].text).toContain("set_promoted_block");
	});
});

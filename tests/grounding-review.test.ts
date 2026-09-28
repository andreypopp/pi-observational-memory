import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runReflectionReview } from "../src/agents/reviewer/agent.js";
import { GROUNDING_SYSTEM, REVIEW_SYSTEM } from "../src/agents/reviewer/prompts.js";
import { createRepoTools, groundingBashTimeout } from "../src/agents/reviewer/repo-tools.js";
import { hashId } from "../src/ids.js";
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

const OLD_A = reflection("aaaaaaaaaaa1", ["aaaaaaaaaaaa"], { content: "Config lives in foo.json" });
const NEW_C = reflection("aaaaaaaaaaa3", ["dddddddddddd"], { content: "Tests run with jest" });

function repoTool(name: string, execute = vi.fn(async () => ({ content: [{ type: "text", text: `${name} output` }], details: {} }))) {
	return { name, label: name, description: name, parameters: {}, execute } as any;
}

function baseArgs(overrides: Record<string, unknown> = {}) {
	return {
		model: {} as any,
		apiKey: "test",
		reflections: [OLD_A, NEW_C],
		newReflectionIds: new Set([NEW_C.id]),
		retiredReflectionIds: new Set<string>(),
		recordedAt: new Map([[OLD_A.id, "2026-05-01 09:00"]]),
		observations: [observation("dddddddddddd", { content: "Recent evidence" })],
		...overrides,
	};
}

function grounding(overrides: Record<string, unknown> = {}) {
	return {
		tools: [repoTool("read"), repoTool("bash")],
		root: "/repo",
		...overrides,
	};
}

/** Runs a review with scripted calls `[toolName, params]`, returning the result, replies and the loop's inputs. */
async function review(calls: [string, unknown][], overrides: Record<string, unknown> = {}) {
	const replies: string[] = [];
	const seen: { prompts: any[]; context: any; config: any } = {} as any;
	const loop = fakeAgentLoop(async (prompts, context, config) => {
		Object.assign(seen, { prompts, context, config });
		for (const [name, params] of calls) {
			const tool = context.tools.find((candidate: any) => candidate.name === name);
			const reply = await tool.execute("tool-1", params);
			replies.push(reply.content[0].text);
		}
	});
	const result = await runReflectionReview({ ...baseArgs(overrides), agentLoop: loop } as any);
	return { result, replies, seen };
}

describe("grounding review", () => {
	it("leaves the normal review without tools or the grounding prompt", async () => {
		const { seen } = await review([]);

		expect(seen.context.tools.map((tool: any) => tool.name)).toEqual(["tidy_reflections"]);
		expect(seen.context.messages[0].content).toBe(REVIEW_SYSTEM);
		expect(seen.prompts[0].content[0].text).not.toContain("REPOSITORY");
	});

	it("gets the repo tools, the full project instructions and the grounding prompt section", async () => {
		const { seen } = await review([], { grounding: grounding(), projectContext: "PROJECT INSTRUCTIONS:\n\nrules" });

		expect(seen.context.tools.map((tool: any) => tool.name)).toEqual(["tidy_reflections", "report_stale_instructions", "read", "bash"]);
		expect(seen.context.messages[0].content).toBe(`${REVIEW_SYSTEM}\n\n${GROUNDING_SYSTEM}`);
		expect(GROUNDING_SYSTEM).not.toMatch(/promot/i);
		const text: string = seen.prompts[0].content[0].text;
		expect(text.startsWith("PROJECT INSTRUCTIONS:\n\nrules\n\nCURRENT REFLECTIONS:")).toBe(true);
		expect(text).toContain("REPOSITORY: /repo");
	});

	it("puts the user instruction right after the project instructions", async () => {
		const { seen } = await review([], { grounding: grounding(), projectContext: "PROJECT INSTRUCTIONS:\n\nrules", userInstruction: "check only the config facts" });

		const text: string = seen.prompts[0].content[0].text;
		expect(text).toMatch(/^PROJECT INSTRUCTIONS:\n\nrules\n\nUSER INSTRUCTION \([^\n]*\):\ncheck only the config facts\n\nCURRENT REFLECTIONS:/);
		expect(seen.context.messages[0].content).toBe(`${REVIEW_SYSTEM}\n\n${GROUNDING_SYSTEM}`);
	});

	it("runs with no active reflections when there are project instructions to check", async () => {
		const { result, seen } = await review([], { reflections: [], grounding: grounding(), projectContext: "PROJECT INSTRUCTIONS:\n\nrules" });

		expect(seen.context).toBeDefined();
		expect(result).toEqual({ replacements: [], retirements: [], grounding: { toolCalls: 0, staleText: [] } });
	});

	it("skips the review with no active reflections and no project instructions", async () => {
		const { result, seen } = await review([], { reflections: [], grounding: grounding() });

		expect(seen.context).toBeUndefined();
		expect(result).toBeUndefined();
	});

	it("counts repo tool calls and reports each running total", async () => {
		const onToolCall = vi.fn();
		const { result } = await review([["read", { path: "x" }], ["bash", { command: "ls" }], ["tidy_reflections", {}]], { grounding: grounding({ onToolCall }) });

		expect(onToolCall.mock.calls).toEqual([[1], [2]]);
		expect(result?.grounding?.toolCalls).toBe(2);
	});

	it("keeps a reason per retirement and on replacements, and may retire a [new] reflection as stale", async () => {
		const { result, replies } = await review([
			["tidy_reflections", {
				retire: [{ id: NEW_C.id, kind: "stale", reason: "package.json:5 runs vitest" }],
				replace: [{ content: "Config lives in bar.json", replacesIds: [OLD_A.id], reason: "src/config.ts:3 reads bar.json" }],
			}],
		], { grounding: grounding() });

		expect(replies[0]).not.toContain("Problems");
		const replacementId = hashId("Config lives in bar.json");
		expect(result?.retirements).toEqual([
			{ reflectionIds: [OLD_A.id], replacedBy: replacementId, reason: "src/config.ts:3 reads bar.json" },
			{ reflectionIds: [NEW_C.id], kind: "stale", reason: "package.json:5 runs vitest" },
		]);
	});

	it("keeps one retirement entry per id in grounding mode, and still refuses other kinds for [new]", async () => {
		const { result, replies } = await review([
			["tidy_reflections", { retire: [{ id: NEW_C.id, kind: "duplicate", reason: "dup" }, { id: OLD_A.id, kind: "stale", reason: "gone" }] }],
		], { grounding: grounding() });

		expect(replies[0]).toContain(`${NEW_C.id} is [new]`);
		expect(result?.retirements).toEqual([{ reflectionIds: [OLD_A.id], kind: "stale", reason: "gone" }]);
	});

	it("drops reasons in normal review and refuses a stale [new] retirement there", async () => {
		const { result, replies } = await review([
			["tidy_reflections", { retire: [{ id: NEW_C.id, kind: "stale", reason: "x" }, { id: OLD_A.id, kind: "stale", reason: "gone" }] }],
		]);

		expect(replies[0]).toContain(`${NEW_C.id} is [new]`);
		expect(result).toEqual({ replacements: [], retirements: [{ reflectionIds: [OLD_A.id], kind: "stale" }] });
	});

	describe("report_stale_instructions", () => {
		it("collects stale-text reports and never offers line edits", async () => {
			const { result, replies, seen } = await review([
				["report_stale_instructions", { report: [{ path: "/repo/AGENTS.md", excerpt: "npm run old", reason: "package.json has no old script" }] }],
			], { grounding: grounding() });

			expect(replies[0]).toBe("Recorded 1 report.");
			expect(Object.keys(seen.context.tools[1].parameters.properties)).toEqual(["report"]);
			expect(result?.grounding).toEqual({
				toolCalls: 0,
				staleText: [{ path: "/repo/AGENTS.md", excerpt: "npm run old", reason: "package.json has no old script" }],
			});
		});

		it("rejects items without a path, an excerpt or a reason", async () => {
			const { result, replies } = await review([
				["report_stale_instructions", { report: [{ path: "/repo/AGENTS.md", excerpt: " ", reason: "x" }] }],
			], { grounding: grounding() });

			expect(replies[0]).toContain("report items need a path, an excerpt and a reason");
			expect(result?.grounding?.staleText).toEqual([]);
		});
	});
});

describe("grounding repo tools", () => {
	let root: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "om-ground-tools-")));
		writeFileSync(join(root, "notes.txt"), "hello\n");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("are Pi's read, grep, find, ls and bash, rooted at the given directory", async () => {
		const tools = createRepoTools(root);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls", "bash"]);

		const read = await tools[0].execute("t1", { path: "notes.txt" });
		expect((read.content[0] as any).text).toContain("hello");
	});

	it("run bash non-interactively in the root", async () => {
		const bash = createRepoTools(root).find((tool) => tool.name === "bash")!;
		const result = await bash.execute("t1", { command: "pwd; echo $GIT_PAGER $PAGER $GIT_TERMINAL_PROMPT $CI $GIT_OPTIONAL_LOCKS" });
		const text = (result.content[0] as any).text as string;
		expect(text).toContain(root);
		expect(text).toContain("cat cat 0 1 0");
	});

	it("bound every bash call's timeout", async () => {
		expect(groundingBashTimeout(undefined)).toBe(60);
		expect(groundingBashTimeout(0)).toBe(60);
		expect(groundingBashTimeout(Number.NaN)).toBe(60);
		expect(groundingBashTimeout(30)).toBe(30);
		expect(groundingBashTimeout(600)).toBe(120);

		const bash = createRepoTools(root).find((tool) => tool.name === "bash")!;
		await expect(bash.execute("t1", { command: "sleep 5", timeout: 0.2 })).rejects.toThrow(/timed out after 0.2 seconds/);
	});
});

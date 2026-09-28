import { describe, expect, it } from "vitest";

import { isClaudeBridgeModel, workerMessages } from "../src/agents/worker-prompt.js";
import { runObserver } from "../src/agents/observer/agent.js";
import { runReflector } from "../src/agents/reflector/agent.js";
import { runDropper } from "../src/agents/dropper/agent.js";
import { OBSERVER_SYSTEM } from "../src/agents/observer/prompts.js";
import { REFLECTOR_SYSTEM } from "../src/agents/reflector/prompts.js";
import { DROPPER_SYSTEM } from "../src/agents/dropper/prompts.js";
import { observation } from "./fixtures/session.js";

const bridgeModel = { provider: "claude-bridge", id: "claude-sonnet-5", baseUrl: "claude-bridge" } as any;
const directModel = { provider: "anthropic", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com" } as any;

function capturingLoop(seen: { prompts?: any[]; context?: any }): any {
	return ((prompts: any[], context: any) => {
		seen.prompts = prompts;
		seen.context = context;
		return { async *[Symbol.asyncIterator]() {}, result: async () => [] };
	}) as any;
}

describe("isClaudeBridgeModel", () => {
	it("is true only for models served at the claude-bridge base url", () => {
		expect(isClaudeBridgeModel(bridgeModel)).toBe(true);
		expect(isClaudeBridgeModel(directModel)).toBe(false);
		expect(isClaudeBridgeModel({} as any)).toBe(false);
	});
});

describe("workerMessages", () => {
	it("puts the instructions in a leading system message for direct providers", () => {
		const { system, prompts } = workerMessages(directModel, "INSTRUCTIONS", "USER TEXT");

		expect(system).toHaveLength(1);
		expect(system[0]).toMatchObject({ role: "system", content: "INSTRUCTIONS" });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "USER TEXT" }] });
	});

	it("opens the user message with the instructions for claude-bridge models", () => {
		const { system, prompts } = workerMessages(bridgeModel, "INSTRUCTIONS", "USER TEXT");

		expect(system).toEqual([]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "INSTRUCTIONS\n\n=====\n\nUSER TEXT" }] });
	});
});

describe("memory workers on a claude-bridge model", () => {
	it("observer sends no system message and opens its user message with OBSERVER_SYSTEM", async () => {
		const seen: { prompts?: any[]; context?: any } = {};
		await runObserver({
			model: bridgeModel,
			apiKey: "test",
			priorReflections: [],
			priorObservations: [],
			chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
			allowedSourceEntryIds: ["entry-a"],
			agentLoop: capturingLoop(seen),
		});

		expect(seen.context.messages).toEqual([]);
		expect(seen.prompts?.[0].content[0].text.startsWith(`${OBSERVER_SYSTEM}\n\n=====\n\n`)).toBe(true);
		expect(seen.prompts?.[0].content[0].text).toContain("NEW CONVERSATION CHUNK:");
	});

	it("reflector sends no system message and opens its user message with REFLECTOR_SYSTEM", async () => {
		const seen: { prompts?: any[]; context?: any } = {};
		await runReflector({
			model: bridgeModel,
			apiKey: "test",
			reflections: [],
			observations: [observation("aaaaaaaaaaaa")],
			agentLoop: capturingLoop(seen),
		});

		expect(seen.context.messages).toEqual([]);
		expect(seen.prompts?.[0].content[0].text.startsWith(`${REFLECTOR_SYSTEM}\n\n=====\n\n`)).toBe(true);
		expect(seen.prompts?.[0].content[0].text).toContain("CURRENT OBSERVATIONS:");
	});

	it("dropper sends no system message and opens its user message with DROPPER_SYSTEM", async () => {
		const seen: { prompts?: any[]; context?: any } = {};
		await runDropper({
			model: bridgeModel,
			apiKey: "test",
			reflections: [],
			observations: [observation("aaaaaaaaaaaa", { tokenCount: 100 })],
			targetTokens: 10,
			agentLoop: capturingLoop(seen),
		});

		expect(seen.context.messages).toEqual([]);
		expect(seen.prompts?.[0].content[0].text.startsWith(`${DROPPER_SYSTEM}\n\n=====\n\n`)).toBe(true);
		expect(seen.prompts?.[0].content[0].text).toContain("Maximum drops allowed this run");
	});
});

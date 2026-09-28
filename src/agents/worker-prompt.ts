import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";

/**
 * pi-claude-bridge serves its models through Claude Code, which runs under its own
 * system prompt. The bridge forwards only system prompts it recorded from Pi's
 * `before_agent_start` and fails the call on any other, so a worker's system message
 * never reaches the model there. Its user message does.
 */
export function isClaudeBridgeModel(model: Model<any>): boolean {
	return (model as { baseUrl?: unknown }).baseUrl === "claude-bridge";
}

export interface WorkerMessages {
	/** Seeds `AgentContext.messages`: the worker's system message, when it has one. */
	system: AgentMessage[];
	/** The loop's prompt: one user message. */
	prompts: Message[];
}

/**
 * Builds a memory worker's opening messages. The instructions go in a leading system
 * message, except on claude-bridge models, where they open the user message instead.
 */
export function workerMessages(model: Model<any>, instructions: string, userText: string): WorkerMessages {
	const timestamp = Date.now();
	if (isClaudeBridgeModel(model)) {
		return {
			system: [],
			prompts: [{ role: "user", content: [{ type: "text", text: `${instructions}\n\n=====\n\n${userText}` }], timestamp }],
		};
	}
	return {
		system: [{ role: "system", content: instructions, timestamp }],
		prompts: [{ role: "user", content: [{ type: "text", text: userText }], timestamp }],
	};
}

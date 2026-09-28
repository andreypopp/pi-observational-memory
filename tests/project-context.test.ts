import { beforeEach, describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({ loadProjectContextFiles: vi.fn() as any }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => "/agent-dir",
	get loadProjectContextFiles() {
		return loader.loadProjectContextFiles;
	},
}));

import { renderProjectContext, withProjectContext } from "../src/agents/project-context.js";
import {
	captureProjectContextFiles,
	refreshProjectContextFromCommand,
	registerProjectContextSnapshot,
	resolveProjectContextFiles,
} from "../src/hooks/project-context.js";
import { Runtime } from "../src/runtime.js";
import { estimateStringTokens } from "../src/tokens.js";

const GLOBAL = { path: "/home/u/.pi/agent/AGENTS.md", content: "g".repeat(400) };
const REPO = { path: "/repo/AGENTS.md", content: "r".repeat(400) };
const CWD = { path: "/repo/pkg/AGENTS.md", content: "c".repeat(400) };

beforeEach(() => {
	loader.loadProjectContextFiles = vi.fn(() => [GLOBAL, CWD]);
});

describe("renderProjectContext", () => {
	it("renders nothing without files", () => {
		expect(renderProjectContext([], 20_000)).toEqual({ text: "", fileCount: 0, estimatedTokens: 0, omitted: [] });
		expect(withProjectContext("", "CURRENT REFLECTIONS:")).toBe("CURRENT REFLECTIONS:");
	});

	it("renders every file in order under the header when they fit", () => {
		const rendered = renderProjectContext([GLOBAL, CWD], 20_000);

		expect(rendered.text).toBe(
			`PROJECT INSTRUCTIONS (loaded into every session of this project; reference only):\n\n### ${GLOBAL.path}\n${GLOBAL.content}\n\n### ${CWD.path}\n${CWD.content}`,
		);
		expect(rendered.fileCount).toBe(2);
		expect(rendered.estimatedTokens).toBe(estimateStringTokens(rendered.text));
		expect(rendered.omitted).toEqual([]);
		expect(withProjectContext(rendered.text, "CURRENT REFLECTIONS:")).toBe(`${rendered.text}\n\nCURRENT REFLECTIONS:`);
	});

	it("keeps the most specific files first and lists omitted ones by path", () => {
		const fileTokens = estimateStringTokens(`### ${CWD.path}\n${CWD.content}`);
		const rendered = renderProjectContext([GLOBAL, REPO, CWD], fileTokens * 2 + 1);

		expect(rendered.fileCount).toBe(2);
		expect(rendered.text).not.toContain(`### ${GLOBAL.path}`);
		expect(rendered.text.indexOf(`### ${REPO.path}`)).toBeLessThan(rendered.text.indexOf(`### ${CWD.path}`));
		expect(rendered.text).toContain(`(omitted: ${GLOBAL.path}, ~${rendered.omitted[0].tokens} tokens)`);
		expect(rendered.omitted.map((file) => file.path)).toEqual([GLOBAL.path]);
	});

	it("never cuts a file: a too-large cwd file is omitted whole", () => {
		const rendered = renderProjectContext([GLOBAL, { path: CWD.path, content: "c".repeat(10_000) }], 200);

		expect(rendered.fileCount).toBe(1);
		expect(rendered.text).toContain(`### ${GLOBAL.path}`);
		expect(rendered.omitted.map((file) => file.path)).toEqual([CWD.path]);
	});
});

describe("project context sources", () => {
	function runtimeWith(config: Partial<Runtime["config"]> = {}): Runtime {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, ...config };
		return runtime;
	}

	it("snapshots context files from before_agent_start and returns nothing", () => {
		const runtime = runtimeWith();
		let handler: ((event: any) => unknown) | undefined;
		registerProjectContextSnapshot({ on: (name: string, cb: any) => { if (name === "before_agent_start") handler = cb; } } as any, runtime);

		const result = handler!({ type: "before_agent_start", systemPromptOptions: { cwd: "/repo", contextFiles: [REPO, { path: 1 }] } });

		expect(result).toBeUndefined();
		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [REPO], source: "snapshot" });
		expect(loader.loadProjectContextFiles).not.toHaveBeenCalled();
	});

	it("keeps the snapshot when an event carries no context files", () => {
		const runtime = runtimeWith();
		captureProjectContextFiles(runtime, [REPO], "snapshot");
		captureProjectContextFiles(runtime, undefined, "snapshot");

		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [REPO], source: "snapshot" });
	});

	it("refreshes from getSystemPromptOptions in a command context", () => {
		const runtime = runtimeWith();
		captureProjectContextFiles(runtime, [REPO], "snapshot");

		refreshProjectContextFromCommand(runtime, { getSystemPromptOptions: () => ({ cwd: "/repo", contextFiles: [CWD] }) });

		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [CWD], source: "command" });
	});

	it("leaves the snapshot alone on a host without getSystemPromptOptions", () => {
		const runtime = runtimeWith();
		captureProjectContextFiles(runtime, [REPO], "snapshot");

		refreshProjectContextFromCommand(runtime, {});

		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [REPO], source: "snapshot" });
	});

	it("falls back to Pi's loader on a fresh Runtime", () => {
		const runtime = runtimeWith();

		expect(resolveProjectContextFiles(runtime, "/repo/pkg")).toEqual({ files: [GLOBAL, CWD], source: "loader" });
		expect(loader.loadProjectContextFiles).toHaveBeenCalledWith({ cwd: "/repo/pkg", agentDir: "/agent-dir" });
	});

	it("reports no files when the host has no loader or it throws", () => {
		const runtime = runtimeWith();
		loader.loadProjectContextFiles = undefined;
		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [], source: "none" });

		loader.loadProjectContextFiles = vi.fn(() => {
			throw new Error("boom");
		});
		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [], source: "none" });
	});

	it("reads nothing when projectContext is false", () => {
		const runtime = runtimeWith({ projectContext: false });
		captureProjectContextFiles(runtime, [REPO], "snapshot");

		expect(resolveProjectContextFiles(runtime, "/repo")).toEqual({ files: [], source: "none" });
		expect(loader.loadProjectContextFiles).not.toHaveBeenCalled();
	});
});

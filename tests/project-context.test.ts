import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	promotedMemoryEnabled,
	refreshProjectContextFromCommand,
	registerProjectContextSnapshot,
	resolveProjectContextFiles,
} from "../src/hooks/project-context.js";
import { renderPromotedMemory } from "../src/project-memory/memory-file.js";
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

describe(".memory.md as a context file", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function repo(memory?: string): { root: string; memoryPath: string } {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "om-memory-md-")));
		dirs.push(root);
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(root, "AGENTS.md"), "rules");
		if (memory !== undefined) writeFileSync(join(root, ".memory.md"), memory);
		return { root, memoryPath: join(root, ".memory.md") };
	}

	const MEMORY = renderPromotedMemory(["- [aaaaaaaaaaaa] Fact A"]);

	function beforeAgentStart(runtime: Runtime) {
		let handler: ((event: any, ctx: any) => unknown) | undefined;
		registerProjectContextSnapshot({ on: (name: string, cb: any) => { if (name === "before_agent_start") handler = cb; } } as any, runtime);
		return (cwd: string, contextFiles: unknown) => {
			const event = { type: "before_agent_start", systemPromptOptions: { cwd, contextFiles } };
			return { result: handler!(event, { cwd }), contextFiles: event.systemPromptOptions.contextFiles as any[] };
		};
	}

	function runtimeWith(config: Partial<Runtime["config"]> = {}): Runtime {
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = { ...runtime.config, ...config };
		return runtime;
	}

	it("appends .memory.md to the main agent's context files, read fresh, stripped of BOM and trailing space", () => {
		const { root, memoryPath } = repo(`\uFEFF${MEMORY}\n\n`);
		const runtime = runtimeWith();
		const start = beforeAgentStart(runtime);
		const agents = { path: join(root, "AGENTS.md"), content: "rules" };

		const { result, contextFiles } = start(join(root, "pkg"), [agents]);
		expect(result).toBeUndefined();
		expect(contextFiles).toEqual([agents, { path: memoryPath, content: MEMORY.trimEnd() }]);
		// The snapshot leaves it out; workers read it fresh after the other files.
		expect(runtime.projectContext).toEqual({ files: [agents], source: "snapshot" });
		expect(resolveProjectContextFiles(runtime, root)).toEqual({ files: [agents, { path: memoryPath, content: MEMORY.trimEnd() }], source: "snapshot" });

		writeFileSync(memoryPath, renderPromotedMemory(["- [bbbbbbbbbbbb] Fact B"]));
		expect(start(root, [agents]).contextFiles.at(-1).content).toContain("Fact B");
		expect(resolveProjectContextFiles(runtime, root).files.at(-1)!.content).toContain("Fact B");
	});

	it("is not added twice when the path is already listed", () => {
		const { root, memoryPath } = repo(MEMORY);
		const listed = { path: memoryPath, content: "listed" };
		expect(beforeAgentStart(runtimeWith())(root, [listed]).contextFiles).toEqual([listed]);

		const runtime = runtimeWith();
		runtime.projectContext = { files: [listed], source: "command" };
		expect(resolveProjectContextFiles(runtime, root).files).toEqual([{ path: memoryPath, content: MEMORY.trimEnd() }]);
	});

	it("changes nothing when .memory.md is missing, empty or has no lines", () => {
		for (const memory of [undefined, "", renderPromotedMemory([]), "Just a note.\n"]) {
			const { root } = repo(memory);
			const runtime = runtimeWith();
			const files = [{ path: join(root, "AGENTS.md"), content: "rules" }];
			expect(beforeAgentStart(runtime)(root, files).contextFiles).toEqual(files);
			expect(resolveProjectContextFiles(runtime, root)).toBe(runtime.projectContext);
		}
	});

	it("leaves a non-array contextFiles alone", () => {
		const { root } = repo(MEMORY);
		expect(beforeAgentStart(runtimeWith())(root, undefined).contextFiles).toBeUndefined();
	});

	it("is off with promotedMemory false, with --no-context-files or -nc, and for workers with projectContext false", () => {
		const { root, memoryPath } = repo(MEMORY);
		const off = runtimeWith({ promotedMemory: false });
		expect(beforeAgentStart(off)(root, []).contextFiles).toEqual([]);
		expect(resolveProjectContextFiles(off, root).files.some((file) => file.path === memoryPath)).toBe(false);

		expect(promotedMemoryEnabled(runtimeWith(), ["node", "pi"])).toBe(true);
		expect(promotedMemoryEnabled(runtimeWith(), ["node", "pi", "--no-context-files"])).toBe(false);
		expect(promotedMemoryEnabled(runtimeWith(), ["node", "pi", "-nc"])).toBe(false);

		expect(resolveProjectContextFiles(runtimeWith({ projectContext: false }), root)).toEqual({ files: [], source: "none" });
	});
});

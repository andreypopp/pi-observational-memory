import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Keep the user's global ~/.pi/agent (settings, AGENTS.md) out of tests.
		env: { PI_CODING_AGENT_DIR: join(tmpdir(), "om-tests-missing-agent-dir") },
	},
});

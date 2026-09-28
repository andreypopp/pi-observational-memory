import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** Pi's context file names in its lookup order (resource-loader `loadContextFileFromDir`). */
export const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export const MEMORY_DIR_NAME = ".memory";

export type PromoteTarget = {
	/** Directory holding the context file and `.memory/`. */
	root: string;
	/** The context file to write; AGENTS.md at `root` when none exists yet. */
	contextPath: string;
	contextExists: boolean;
	memoryDir: string;
	/** Set when cwd is inside a linked git worktree: the target is then the main worktree's root. */
	linkedWorktreeRoot?: string;
};

type GitRoots = { worktreeRoot: string; mainRoot: string };

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The git worktree containing `cwd` and its main worktree, read from `.git`, `gitdir` and `commondir`
 * the way Pi's `findGitPaths` does (no git subprocess). `mainRoot` equals `worktreeRoot` for an ordinary
 * repo, and for layouts whose common dir is not a checked-out `.git` (bare repos, submodules).
 */
export function findGitRoots(cwd: string): GitRoots | undefined {
	let dir = resolve(cwd);
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isDirectory()) return existsSync(join(gitPath, "HEAD")) ? { worktreeRoot: dir, mainRoot: dir } : undefined;
				const content = readFileSync(gitPath, "utf8").trim();
				if (!content.startsWith("gitdir: ")) return undefined;
				const gitDir = resolve(dir, content.slice(8).trim());
				if (!existsSync(join(gitDir, "HEAD"))) return undefined;
				const commonDirPath = join(gitDir, "commondir");
				const commonGitDir = existsSync(commonDirPath) ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim()) : gitDir;
				const mainRoot = basename(commonGitDir) === ".git" && commonGitDir !== gitDir ? dirname(commonGitDir) : dir;
				return { worktreeRoot: dir, mainRoot };
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The first existing context file in `dir`, in Pi's candidate order. */
export function findContextFile(dir: string): string | undefined {
	for (const name of CONTEXT_FILE_CANDIDATES) {
		const path = join(dir, name);
		if (isFile(path)) return path;
	}
	return undefined;
}

/**
 * Where /om:promote writes: the context file Pi loads from the repository root (the main worktree's root
 * when cwd is in a linked worktree, so no new context file is created inside one), or cwd outside git.
 */
export function resolvePromoteTarget(cwd: string): PromoteTarget {
	const roots = findGitRoots(cwd);
	const root = roots?.mainRoot ?? resolve(cwd);
	const existing = findContextFile(root);
	return {
		root,
		contextPath: existing ?? join(root, "AGENTS.md"),
		contextExists: existing !== undefined,
		memoryDir: join(root, MEMORY_DIR_NAME),
		...(roots && roots.mainRoot !== roots.worktreeRoot ? { linkedWorktreeRoot: roots.worktreeRoot } : {}),
	};
}

/** `path` relative to `cwd` when it lies inside it, else `path` unchanged. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

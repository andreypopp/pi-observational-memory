import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { MEMORY_FILE_NAME } from "./memory-file.js";

export const MEMORY_DIR_NAME = ".memory";

export type PromoteTarget = {
	/** Directory holding `.memory.md` and `.memory/`. */
	root: string;
	/** The promoted lines' file, `.memory.md` at `root`. */
	memoryPath: string;
	memoryDir: string;
	/** Set when cwd is inside a linked git worktree: the target is then the main worktree's root. */
	linkedWorktreeRoot?: string;
};

type GitRoots = { worktreeRoot: string; mainRoot: string };

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

/**
 * Where /om:promote writes: `.memory.md` and `.memory/` at the repository root (the main worktree's root
 * when cwd is in a linked worktree, so every worktree shares them), or at cwd outside git.
 */
export function resolvePromoteTarget(cwd: string): PromoteTarget {
	const roots = findGitRoots(cwd);
	const root = roots?.mainRoot ?? resolve(cwd);
	return {
		root,
		memoryPath: join(root, MEMORY_FILE_NAME),
		memoryDir: join(root, MEMORY_DIR_NAME),
		...(roots && roots.mainRoot !== roots.worktreeRoot ? { linkedWorktreeRoot: roots.worktreeRoot } : {}),
	};
}

/** `path` relative to `cwd` when it lies inside it, else `path` unchanged. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

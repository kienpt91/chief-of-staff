import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CosError } from "./errors.js";

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  return env;
}

/** Runs git and never throws on a non-zero exit. */
export function gitTry(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new CosError(`failed to run git: ${r.error.message}`);
  return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs git and returns trimmed stdout; throws CosError with git's stderr on failure. */
export function git(cwd: string, args: string[]): string {
  const r = gitTry(cwd, args);
  if (!r.ok) {
    throw new CosError(`git ${args.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}

export interface RepoInfo {
  /** Main working tree of the repository (never a linked worktree). */
  root: string;
  /** Common git dir (`.git` of the main working tree). */
  gitDir: string;
}

/** Finds the main working tree for any directory inside a repository or one of its worktrees. */
export function findRepo(startDir: string): RepoInfo {
  const dir = path.resolve(startDir);
  if (!fs.existsSync(dir)) throw new CosError(`path does not exist: ${dir}`);
  const inside = gitTry(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new CosError(`${dir} is not inside a git working tree; chief-of-staff only runs inside a git repository`);
  }
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  const gitDir = path.resolve(dir, common);
  const list = git(dir, ["worktree", "list", "--porcelain"]);
  const first = list.split("\n").find((l) => l.startsWith("worktree "));
  if (!first) throw new CosError("could not determine the main working tree");
  return { root: fs.realpathSync(first.slice("worktree ".length)), gitDir: fs.realpathSync(gitDir) };
}

export function hasCommits(root: string): boolean {
  return gitTry(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).ok;
}

export function branchExists(root: string, branch: string): boolean {
  return gitTry(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

/** Passes an identity only when the repository has none configured, so commits never fail. */
export function identityArgs(cwd: string): string[] {
  const email = gitTry(cwd, ["config", "user.email"]);
  const name = gitTry(cwd, ["config", "user.name"]);
  if (email.ok && email.stdout.trim() && name.ok && name.stdout.trim()) return [];
  return ["-c", "user.name=chief-of-staff", "-c", "user.email=chief-of-staff@localhost"];
}

export function isDirty(worktree: string): boolean {
  return git(worktree, ["status", "--porcelain", "--untracked-files=all"]) !== "";
}

/** Adds ignore patterns to the shared info/exclude of the repository (idempotent). */
export function ensureExcluded(repo: RepoInfo, patterns: string[]): void {
  const file = path.join(repo.gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = new Set(current.split("\n").map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, `${current}${prefix}${missing.join("\n")}\n`);
}

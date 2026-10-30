import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENV_ALLOW } from "./config.js";
import { CosError } from "./errors.js";

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment of every git process cos starts: the same allowlist workers get, nothing else.
 * Anything git runs on cos's behalf (hooks, filters, drivers planted in the shared .git) therefore
 * sees no tokens or credentials from the coordinator's shell.
 */
export function gitEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_ENV_ALLOW) {
    const v = parent[key];
    if (v !== undefined) env[key] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * Config that makes git refuse to execute anything from the repository's (worker-writable) config or
 * hooks directory. Passed on the command line, so it wins over every config file and has no race window.
 */
export const SAFE_GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.editor=true",
  "core.sshCommand=false",
  "core.askPass=false",
  "core.attributesFile=/dev/null",
  "credential.helper=",
  "protocol.allow=never",
  "protocol.ext.allow=never",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "gc.auto=0",
  "maintenance.auto=false",
];

function configFlags(entries: string[]): string[] {
  return entries.flatMap((e) => ["-c", e]);
}

const DRIVER_GUARDED = new Set(["add", "commit", "merge", "status", "diff", "checkout", "reset", "worktree", "stash"]);

function subcommandOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i += 1;
    else return args[i];
  }
  return undefined;
}

/**
 * Config keys whose *names* are chosen by whoever writes the config: clean/smudge filters, external diff
 * and textconv programs, merge drivers, per-command pagers, credential and signing programs.
 * They cannot be switched off with a fixed -c flag, so the current repo config is listed (listing
 * executes nothing) and each such key is overridden for this one command. A driver planted by a
 * concurrently running worker between the listing and the command is not covered; its environment
 * would still be the allowlisted one.
 */
export function neutralizingConfig(cwd: string): string[] {
  const r = spawnSync("git", [...configFlags(SAFE_GIT_CONFIG), "config", "--list", "-z"], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return [];
  const out = new Set<string>();
  for (const entry of r.stdout.split("\0")) {
    const key = entry.split("\n")[0] ?? "";
    let m: RegExpExecArray | null;
    if ((m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key))) {
      out.add(`filter.${m[1]}.${m[2]}=`);
      out.add(`filter.${m[1]}.required=false`);
    } else if ((m = /^diff\.(.+)\.(command|textconv)$/i.exec(key))) {
      out.add(`diff.${m[1]}.${m[2]}=`);
    } else if ((m = /^merge\.(.+)\.driver$/i.exec(key))) {
      out.add(`merge.${m[1]}.driver=false`);
    } else if ((m = /^pager\.(.+)$/i.exec(key))) {
      out.add(`pager.${m[1]}=cat`);
    } else if ((m = /^credential\.(.+)\.helper$/i.exec(key))) {
      out.add(`credential.${m[1]}.helper=`);
    } else if (/^gpg\.(.+\.)?program$/i.test(key)) {
      out.add(`${key}=false`);
    }
  }
  return [...out];
}

function hardenedArgs(cwd: string, args: string[]): string[] {
  const sub = subcommandOf(args);
  const dynamic = sub !== undefined && DRIVER_GUARDED.has(sub) ? neutralizingConfig(cwd) : [];
  return [...configFlags(SAFE_GIT_CONFIG), ...configFlags(dynamic), ...args];
}

/** Runs git and never throws on a non-zero exit. */
export function gitTry(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", hardenedArgs(cwd, args), {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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

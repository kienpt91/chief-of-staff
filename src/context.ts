import path from "node:path";
import type { Config } from "./config.js";
import type { RepoInfo } from "./git.js";
import type { Store } from "./store.js";

export interface Ctx {
  repo: RepoInfo;
  store: Store;
  loadConfig: () => Config;
  /** absolute path of the configuration file (for diagnostics) */
  configFile: string;
  /** How often supervisors poll running workers (questions, heartbeat). */
  pollMs: number;
  log: (message: string) => void;
}

export const WORKTREES_DIRNAME = ".cos-worktrees";

/** Written to .git/info/exclude. `.cos` has no trailing slash on purpose, so a symlink named .cos is ignored too. */
export const EXCLUDE_PATTERNS = [`${WORKTREES_DIRNAME}/`, ".cos"];

/** Worker names as they may appear in plans and in the config. */
export const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
export const INTEGRATION_DIRNAME = "_integration";

export function worktreesRoot(ctx: Ctx): string {
  return path.join(ctx.repo.root, WORKTREES_DIRNAME);
}

export function taskWorktreePath(ctx: Ctx, runId: string, taskId: string): string {
  return path.join(worktreesRoot(ctx), runId, taskId);
}

export function integrationWorktreePath(ctx: Ctx, runId: string): string {
  return path.join(worktreesRoot(ctx), runId, INTEGRATION_DIRNAME);
}

export function taskBranch(runId: string, taskId: string): string {
  return `cos/${runId}/${taskId}`;
}

export function integrationBranchName(runId: string): string {
  return `cos/${runId}/integration`;
}

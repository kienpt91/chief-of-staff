import path from "node:path";
import type { Config } from "./config.js";
import type { RepoInfo } from "./git.js";
import type { Store } from "./store.js";

export interface Ctx {
  repo: RepoInfo;
  store: Store;
  loadConfig: () => Config;
  /** How often supervisors poll running workers (questions, heartbeat). */
  pollMs: number;
  log: (message: string) => void;
}

export const WORKTREES_DIRNAME = ".cos-worktrees";
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

import fs from "node:fs";
import path from "node:path";
import { integrationWorktreePath, taskBranch, type Ctx } from "./context.js";
import { topoOrder } from "./dag.js";
import { CosError } from "./errors.js";
import { withLock } from "./fsutil.js";
import { branchExists, git, gitTry, identityArgs, isDirty } from "./git.js";
import { refreshTx } from "./tasks.js";
import type { Run } from "./types.js";

export interface MergeResult {
  taskId: string;
  merged: boolean;
  /** true when the task had already been merged earlier */
  already?: boolean;
  commit?: string;
  conflicts?: string[];
}

/**
 * The integration branch lives in its own worktree so merging never touches the user's
 * working tree or checked-out branch.
 */
export function ensureIntegrationWorktree(ctx: Ctx, run: Run): string {
  const wt = integrationWorktreePath(ctx, run.id);
  if (fs.existsSync(path.join(wt, ".git"))) return wt;
  gitTry(ctx.repo.root, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(ctx.repo.root, ["worktree", "add", wt, run.integrationBranch]);
  return wt;
}

export function mergeTask(ctx: Ctx, runId: string, taskId: string): Promise<MergeResult> {
  const lock = path.join(ctx.store.runDir(runId), "merge.lock");
  return withLock(lock, async () => mergeLocked(ctx, runId, taskId));
}

function mergeLocked(ctx: Ctx, runId: string, taskId: string): MergeResult {
  const run = ctx.store.getRun(runId);
  const task = ctx.store.getTask(runId, taskId);
  if (task.merged) return { taskId, merged: true, already: true, commit: task.merged.commit };
  const retryable = task.status === "blocked" && task.blocked?.kind === "merge-conflict";
  if (task.status !== "completed" && !retryable) {
    throw new CosError(`task "${taskId}" is ${task.status}; only completed tasks can be merged`);
  }
  const branch = taskBranch(runId, taskId);
  if (!branchExists(ctx.repo.root, branch)) throw new CosError(`branch ${branch} does not exist`);

  const wt = ensureIntegrationWorktree(ctx, run);
  if (isDirty(wt)) throw new CosError(`integration worktree ${wt} has uncommitted changes; refusing to merge`);

  const message = `Merge task ${taskId}: ${task.title}`;
  const res = gitTry(wt, [...identityArgs(wt), "merge", "--no-ff", "-m", message, branch]);

  if (res.ok) {
    const commit = git(wt, ["rev-parse", "HEAD"]);
    ctx.store.tx(runId, (s) => {
      const t = s.getTask(runId, taskId);
      t.merged = { at: new Date().toISOString(), commit };
      t.mergeConflict = undefined;
      if (t.status === "blocked" && t.blocked?.kind === "merge-conflict") {
        t.status = "completed";
        t.blocked = undefined;
      }
      s.putTask(t);
      refreshTx(s, runId);
    });
    return { taskId, merged: true, commit };
  }

  const conflicts = gitTry(wt, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const abort = gitTry(wt, ["merge", "--abort"]);
  if (!abort.ok) git(wt, ["reset", "--hard", "HEAD"]);
  if (conflicts.length === 0) {
    throw new CosError(`merging ${branch} into ${run.integrationBranch} failed: ${(res.stderr || res.stdout).trim()}`);
  }

  ctx.store.tx(runId, (s) => {
    const t = s.getTask(runId, taskId);
    t.status = "blocked";
    t.blocked = { kind: "merge-conflict", files: conflicts, detail: `conflicts with ${run.integrationBranch}` };
    t.mergeConflict = { files: conflicts, at: new Date().toISOString() };
    s.putTask(t);
    s.addMessage({
      runId,
      type: "escalation",
      from: "coordinator",
      to: "coordinator",
      taskId,
      body: `merging task ${taskId} into ${run.integrationBranch} conflicts in: ${conflicts.join(", ")}. The merge was aborted; the task is blocked. Resolve with "cos retry --task ${taskId}" or fix the branch and run "cos merge --task ${taskId}" again.`,
      payload: { files: conflicts },
    });
    refreshTx(s, runId);
  });
  return { taskId, merged: false, conflicts };
}

/** Merges every completed, not yet merged task, dependencies first. Conflicts do not stop the others. */
export async function mergeRun(ctx: Ctx, runId: string): Promise<MergeResult[]> {
  const tasks = topoOrder(ctx.store.listTasks(runId));
  const results: MergeResult[] = [];
  for (const t of tasks) {
    if (t.status !== "completed" || t.merged) continue;
    results.push(await mergeTask(ctx, runId, t.id));
  }
  return results;
}

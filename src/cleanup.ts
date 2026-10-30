import fs from "node:fs";
import path from "node:path";
import {
  integrationBranchName,
  integrationWorktreePath,
  taskBranch,
  taskWorktreePath,
  worktreesRoot,
  type Ctx,
} from "./context.js";
import { CosError } from "./errors.js";
import { git, gitTry, isDirty } from "./git.js";
import { isSameProcess } from "./process.js";

export interface CleanupOptions {
  runId?: string;
  taskId?: string;
  /** discard uncommitted changes */
  force?: boolean;
  /** also delete task branches that are merged into the integration branch (all of them with force) */
  branches?: boolean;
}

export interface CleanupEntry {
  runId: string;
  /** task id, or "integration" for the run's integration worktree */
  name: string;
  path: string;
  action: "removed" | "skipped";
  reason?: string;
  branch?: "deleted" | "kept";
}

function registeredWorktrees(ctx: Ctx): Set<string> {
  const out = git(ctx.repo.root, ["worktree", "list", "--porcelain"]);
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length);
    set.add(fs.existsSync(p) ? fs.realpathSync(p) : p);
  }
  return set;
}

function assertInsideWorktreeRoot(ctx: Ctx, target: string): void {
  const root = worktreesRoot(ctx) + path.sep;
  if (!path.resolve(target).startsWith(root)) {
    throw new CosError(`refusing to touch ${target}: it is outside ${root}`);
  }
}

/**
 * Removes worktrees under `<repo>/.cos-worktrees/`. Never removes a worktree with uncommitted
 * changes unless `force` is set, never touches a worktree whose worker is still running, and never
 * deletes the integration branch.
 */
export function cleanup(ctx: Ctx, opts: CleanupOptions = {}): CleanupEntry[] {
  const runs = opts.runId ? [ctx.store.getRun(opts.runId)] : ctx.store.listRuns();
  if (opts.taskId && !opts.runId) throw new CosError("--task needs --run (or a single run in the repository)");
  gitTry(ctx.repo.root, ["worktree", "prune"]);
  const registered = registeredWorktrees(ctx);
  const entries: CleanupEntry[] = [];

  for (const run of runs) {
    const tasks = ctx.store.listTasks(run.id).filter((t) => !opts.taskId || t.id === opts.taskId);
    if (opts.taskId && tasks.length === 0) throw new CosError(`unknown task "${opts.taskId}" in run "${run.id}"`);
    const dispatches = ctx.store.listDispatches(run.id);

    const targets: { name: string; wt: string; branch?: string }[] = tasks.map((t) => ({
      name: t.id,
      wt: taskWorktreePath(ctx, run.id, t.id),
      branch: taskBranch(run.id, t.id),
    }));
    if (!opts.taskId) targets.push({ name: "integration", wt: integrationWorktreePath(ctx, run.id) });

    for (const target of targets) {
      if (!fs.existsSync(target.wt)) {
        if (opts.taskId) entries.push({ runId: run.id, name: target.name, path: target.wt, action: "skipped", reason: "no worktree on disk" });
        continue;
      }
      assertInsideWorktreeRoot(ctx, target.wt);
      const entry: CleanupEntry = { runId: run.id, name: target.name, path: target.wt, action: "skipped" };
      entries.push(entry);

      const live = dispatches.find(
        (d) =>
          d.taskId === target.name &&
          (d.status === "running" || d.status === "gating") &&
          isSameProcess(d.supervisorPid, d.supervisorStart),
      );
      if (live) {
        entry.reason = `worker is running (dispatch ${live.id})`;
        continue;
      }
      if (!registered.has(fs.realpathSync(target.wt))) {
        entry.reason = "not a registered git worktree; remove it by hand if it is stale";
        continue;
      }
      if (!opts.force && isDirty(target.wt)) {
        entry.reason = "uncommitted changes (use --force to discard them)";
        continue;
      }
      const removed = gitTry(ctx.repo.root, ["worktree", "remove", ...(opts.force ? ["--force"] : []), target.wt]);
      if (!removed.ok) {
        entry.reason = (removed.stderr || removed.stdout).trim();
        continue;
      }
      entry.action = "removed";

      if (opts.branches && target.branch) {
        const merged = gitTry(ctx.repo.root, ["merge-base", "--is-ancestor", target.branch, integrationBranchName(run.id)]).ok;
        if (merged || opts.force) {
          entry.branch = gitTry(ctx.repo.root, ["branch", "-D", target.branch]).ok ? "deleted" : "kept";
        } else {
          entry.branch = "kept";
        }
      }
    }
    const runWtDir = path.join(worktreesRoot(ctx), run.id);
    if (fs.existsSync(runWtDir) && fs.readdirSync(runWtDir).length === 0) fs.rmdirSync(runWtDir);
  }
  gitTry(ctx.repo.root, ["worktree", "prune"]);
  return entries;
}

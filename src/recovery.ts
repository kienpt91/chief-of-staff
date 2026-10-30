import type { Ctx } from "./context.js";
import { sleepSync } from "./fsutil.js";
import { isSameProcess, killGroup } from "./process.js";
import { refreshTx } from "./tasks.js";
import type { Dispatch } from "./types.js";

function stopOrphanedWorker(d: Dispatch, graceMs: number): boolean {
  if (d.pid === undefined || !isSameProcess(d.pid, d.pidStart)) return false;
  killGroup(d.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isSameProcess(d.pid, d.pidStart)) sleepSync(25);
  killGroup(d.pid, "SIGKILL");
  return true;
}

/**
 * Dispatch records are written before a worker starts and carry the supervisor's pid. If that
 * supervisor is gone (crash, kill -9, reboot) while the dispatch is still "running" or "gating",
 * nobody will ever record its outcome. Such dispatches are marked orphaned, any leftover worker
 * process group is stopped, and the task becomes failed so it can be retried.
 */
export function recoverOrphans(ctx: Ctx, runId?: string): Dispatch[] {
  const graceMs = ctx.loadConfig().killGraceSec * 1000;
  const runs = runId ? [ctx.store.getRun(runId)] : ctx.store.listRuns();
  const recovered: Dispatch[] = [];

  for (const run of runs) {
    for (const candidate of ctx.store.listDispatches(run.id)) {
      if (candidate.status !== "running" && candidate.status !== "gating") continue;
      if (isSameProcess(candidate.supervisorPid, candidate.supervisorStart)) continue;

      const killed = stopOrphanedWorker(candidate, graceMs);
      const done = ctx.store.tx(run.id, (s) => {
        const d = s.getDispatch(run.id, candidate.id);
        if (d.status !== "running" && d.status !== "gating") return undefined; // someone else recovered it
        const reason = `supervisor process ${d.supervisorPid} is gone; dispatch ${d.id} was interrupted while ${d.status}${killed ? " (leftover worker process group stopped)" : ""}`;
        d.status = "orphaned";
        d.failureKind = "orphaned";
        d.failure = reason;
        d.endedAt = new Date().toISOString();
        s.putDispatch(d);

        const task = s.findTask(run.id, d.taskId);
        if (task && (task.status === "dispatched" || task.status === "review")) {
          task.status = "failed";
          task.failure = reason;
          s.putTask(task);
        }
        s.addMessage({
          runId: run.id,
          type: "escalation",
          from: "coordinator",
          to: "coordinator",
          taskId: d.taskId,
          dispatchId: d.id,
          body: `task ${d.taskId}: ${reason}. Use "cos retry --task ${d.taskId}" to run it again.`,
        });
        refreshTx(s, run.id);
        return d;
      });
      if (done) recovered.push(done);
    }
  }
  return recovered;
}

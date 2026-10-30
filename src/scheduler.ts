import type { Ctx } from "./context.js";
import { dispatchTask, retryTask } from "./dispatch.js";
import { sleep } from "./fsutil.js";
import { mergeRun, type MergeResult } from "./merge.js";
import { recoverOrphans } from "./recovery.js";
import { listTasksRefreshed } from "./tasks.js";
import { TASK_STATUSES, type Task, type TaskStatus } from "./types.js";

export interface RunStartOptions {
  /** max simultaneously running workers for this run (counts dispatches started by other processes too) */
  concurrency?: number;
  /** merge completed tasks into the integration branch when nothing else is runnable (default true) */
  merge?: boolean;
  /** automatically retry a failed task up to this many times (default 0) */
  retries?: number;
  /** keep polling while tasks wait for an answer or a decision, instead of returning */
  wait?: boolean;
}

export interface Attention {
  taskId: string;
  status: TaskStatus;
  reason: string;
}

export interface RunSummary {
  runId: string;
  counts: Record<TaskStatus, number>;
  dispatches: number;
  merges: MergeResult[];
  attention: Attention[];
  /** every task completed (and merged, when merging is enabled) */
  complete: boolean;
}

function describeAttention(t: Task, byId: Map<string, Task>): Attention | undefined {
  switch (t.status) {
    case "failed":
      return { taskId: t.id, status: t.status, reason: t.failure ?? "failed" };
    case "blocked":
      return {
        taskId: t.id,
        status: t.status,
        reason: `${t.blocked?.kind ?? "blocked"}${t.blocked?.detail ? `: ${t.blocked.detail}` : ""}${t.blocked?.files ? ` [${t.blocked.files.join(", ")}]` : ""}`,
      };
    case "pending": {
      const waiting = t.after.filter((d) => byId.get(d)?.status !== "completed");
      return { taskId: t.id, status: t.status, reason: `waiting for ${waiting.join(", ")}` };
    }
    default:
      return undefined;
  }
}

export async function runStart(ctx: Ctx, runId: string, opts: RunStartOptions = {}): Promise<RunSummary> {
  ctx.store.getRun(runId);
  const limit = opts.concurrency ?? ctx.loadConfig().concurrency;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency must be an integer >= 1");
  const retries = opts.retries ?? 0;
  const doMerge = opts.merge ?? true;

  const inFlight = new Map<string, Promise<void>>();
  const skipped = new Set<string>();
  const retried = new Map<string, number>();
  let dispatches = 0;

  const launch = (taskId: string, mode: "dispatch" | "retry"): void => {
    dispatches += 1;
    const p = (mode === "retry" ? retryTask(ctx, runId, taskId) : dispatchTask(ctx, runId, taskId))
      .then(() => undefined)
      .catch((err: unknown) => {
        skipped.add(taskId);
        ctx.log(`task ${taskId} could not be dispatched: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inFlight.delete(taskId);
      });
    inFlight.set(taskId, p);
  };

  recoverOrphans(ctx, runId);
  for (;;) {
    const tasks = listTasksRefreshed(ctx, runId);
    const activeIds = new Set(tasks.filter((t) => t.status === "dispatched" || t.status === "review").map((t) => t.id));
    const active = activeIds.size;
    // tasks we just launched may not have claimed their dispatch yet, so count them explicitly
    for (const id of inFlight.keys()) activeIds.add(id);
    let capacity = limit - activeIds.size;
    let launched = 0;

    for (const t of tasks) {
      if (capacity <= 0) break;
      if (inFlight.has(t.id) || skipped.has(t.id)) continue;
      if (t.status === "ready") {
        launch(t.id, "dispatch");
      } else if (t.status === "failed" && (retried.get(t.id) ?? 0) < retries) {
        retried.set(t.id, (retried.get(t.id) ?? 0) + 1);
        launch(t.id, "retry");
      } else {
        continue;
      }
      capacity -= 1;
      launched += 1;
    }

    if (inFlight.size === 0 && launched === 0) {
      const waitingOnHuman = tasks.some((t) => t.status === "blocked" && (t.blocked?.kind === "question" || t.blocked?.kind === "decision"));
      if (active > 0 || (opts.wait && waitingOnHuman)) {
        recoverOrphans(ctx, runId);
        await sleep(ctx.pollMs);
        continue;
      }
      break;
    }
    await Promise.race([...inFlight.values(), sleep(ctx.pollMs)]);
  }

  const merges = doMerge ? await mergeRun(ctx, runId) : [];
  const final = listTasksRefreshed(ctx, runId);
  const byId = new Map(final.map((t) => [t.id, t]));
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of final) counts[t.status] += 1;
  const attention = final.map((t) => describeAttention(t, byId)).filter((a): a is Attention => a !== undefined);
  const complete = final.length > 0 && final.every((t) => t.status === "completed" && (!doMerge || t.merged));
  return { runId, counts, dispatches, merges, attention, complete };
}

import type { Ctx } from "./context.js";
import { depths, topoOrder } from "./dag.js";
import { listTasksRefreshed } from "./tasks.js";
import { TASK_STATUSES, type Run, type Task, type TaskStatus } from "./types.js";

export interface StatusReport {
  run: Run;
  counts: Record<TaskStatus, number>;
  /** dependencies first */
  tasks: (Task & { depth: number })[];
}

export function buildStatus(ctx: Ctx, runId: string): StatusReport {
  const run = ctx.store.getRun(runId);
  const tasks = listTasksRefreshed(ctx, runId);
  const depth = depths(tasks);
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status] += 1;
  return {
    run,
    counts,
    tasks: topoOrder(tasks).map((t) => ({ ...t, depth: depth.get(t.id) ?? 0 })),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export function renderStatusText(report: StatusReport): string {
  const { run, counts, tasks } = report;
  const lines: string[] = [];
  lines.push(`Run ${run.id}: ${oneLine(run.objective, 100)}`);
  lines.push(`  base ${run.baseRef}@${run.baseCommit.slice(0, 7)}, integration branch ${run.integrationBranch}`);
  const summary = TASK_STATUSES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  lines.push(`  ${tasks.length} task(s)${summary.length > 0 ? `: ${summary.join(", ")}` : ""}`);
  if (tasks.length === 0) return lines.join("\n");

  const idWidth = Math.max(...tasks.map((t) => t.id.length));
  const statusWidth = Math.max(...TASK_STATUSES.map((s) => s.length));
  let currentDepth = -1;
  for (const t of tasks.slice().sort((a, b) => a.depth - b.depth || a.order - b.order)) {
    if (t.depth !== currentDepth) {
      currentDepth = t.depth;
      lines.push("");
      lines.push(`  level ${t.depth}${t.depth === 0 ? " (no dependencies)" : ""}`);
    }
    const flags: string[] = [];
    if (t.merged) flags.push("merged");
    if (t.attempts > 1) flags.push(`attempt ${t.attempts}`);
    lines.push(`    ${pad(t.id, idWidth)}  ${pad(t.status, statusWidth)}  ${oneLine(t.title, 60)}${flags.length > 0 ? `  (${flags.join(", ")})` : ""}`);
    if (t.after.length > 0) lines.push(`    ${pad("", idWidth)}  ${pad("", statusWidth)}  after: ${t.after.join(", ")}`);
    if (t.status === "blocked" && t.blocked) {
      const files = t.blocked.files ? ` [${t.blocked.files.join(", ")}]` : "";
      lines.push(`    ${pad("", idWidth)}  ${pad("", statusWidth)}  blocked on ${t.blocked.kind}${t.blocked.ref ? ` ${t.blocked.ref}` : ""}: ${oneLine(t.blocked.detail ?? "", 80)}${files}`);
    }
    if (t.status === "failed" && t.failure) {
      lines.push(`    ${pad("", idWidth)}  ${pad("", statusWidth)}  ${oneLine(t.failure, 100)}`);
    }
  }
  return lines.join("\n");
}

const MERMAID_CLASS: Record<TaskStatus, string> = {
  pending: "pending",
  ready: "ready",
  dispatched: "running",
  review: "running",
  completed: "done",
  failed: "failed",
  blocked: "blocked",
};

export function renderStatusMermaid(report: StatusReport): string {
  const lines = ["flowchart TD"];
  for (const t of report.tasks) {
    const label = `${t.id}: ${t.title}`.replace(/"/g, "'");
    lines.push(`  ${t.id.replace(/[^\w]/g, "_")}["${label}<br/>${t.status}"]:::${MERMAID_CLASS[t.status]}`);
  }
  for (const t of report.tasks) {
    for (const dep of t.after) lines.push(`  ${dep.replace(/[^\w]/g, "_")} --> ${t.id.replace(/[^\w]/g, "_")}`);
  }
  lines.push("  classDef pending fill:#eee,stroke:#999");
  lines.push("  classDef ready fill:#dbeafe,stroke:#3b82f6");
  lines.push("  classDef running fill:#fef9c3,stroke:#eab308");
  lines.push("  classDef done fill:#dcfce7,stroke:#22c55e");
  lines.push("  classDef failed fill:#fee2e2,stroke:#ef4444");
  lines.push("  classDef blocked fill:#ffedd5,stroke:#f97316");
  return lines.join("\n");
}

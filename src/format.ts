import type { CleanupEntry } from "./cleanup.js";
import type { MergeResult } from "./merge.js";
import type { RunSummary } from "./scheduler.js";
import { TASK_STATUSES, type Decision, type Dispatch, type Message, type Run, type Task } from "./types.js";

function oneLine(s: string, max = 110): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

export function formatRun(run: Run): string {
  return `${run.id}  ${oneLine(run.objective, 80)}  (integration branch ${run.integrationBranch})`;
}

export function formatDispatch(d: Dispatch): string {
  const lines = [`dispatch ${d.id} for task ${d.taskId}: ${d.status} (attempt ${d.attempt})`];
  if (d.failure) lines.push(`  ${oneLine(d.failure, 160)}`);
  for (const g of d.gates ?? []) lines.push(`  gate ${g.name}: ${g.passed ? "passed" : "FAILED"} (${g.summary})`);
  for (const w of d.warnings ?? []) lines.push(`  warning: ${oneLine(w, 160)}`);
  return lines.join("\n");
}

export function formatMessage(m: Message): string {
  const where = m.taskId ? ` task=${m.taskId}` : "";
  const state = m.type === "question" ? (m.answer ? " [answered]" : " [unanswered]") : m.ackedAt ? " [acked]" : "";
  const head = `${m.id}  ${m.type}${where}${m.dispatchId ? ` dispatch=${m.dispatchId}` : ""}  from ${m.from}${state}`;
  const options = Array.isArray(m.payload?.options) ? `\n    options: ${(m.payload?.options as string[]).join(" | ")}` : "";
  const answer = m.answer ? `\n    answer: ${m.answer.text}` : "";
  return `${head}\n    ${oneLine(m.body, 200)}${options}${answer}`;
}

export function formatDecision(d: Decision): string {
  const head = `${d.id}  task=${d.taskId}  [${d.status}]  ${oneLine(d.question, 120)}`;
  const options = d.options && d.options.length > 0 ? `\n    options: ${d.options.join(" | ")}` : "";
  const decision = d.decision ? `\n    decision: ${d.decision}` : "";
  return `${head}${options}${decision}`;
}

export function formatTask(t: Task, dispatches: Dispatch[]): string {
  const lines = [
    `task ${t.id}: ${t.title}`,
    `  status: ${t.status}${t.blocked ? ` (${t.blocked.kind}${t.blocked.ref ? ` ${t.blocked.ref}` : ""})` : ""}${t.merged ? ", merged" : ""}`,
    `  after: ${t.after.length > 0 ? t.after.join(", ") : "-"}`,
    `  attempts: ${t.attempts}`,
  ];
  if (t.worker) lines.push(`  worker: ${t.worker}`);
  lines.push("  spec:", indent(t.spec, "    "));
  if (t.acceptance.length > 0) lines.push("  acceptance:", ...t.acceptance.map((a) => `    - ${a}`));
  if (t.summary) lines.push(`  summary: ${t.summary}`);
  if (t.failure) lines.push(`  failure: ${t.failure}`);
  for (const d of dispatches) {
    lines.push(`  ${d.id} (attempt ${d.attempt}): ${d.status}${d.exitCode !== undefined && d.exitCode !== null ? `, exit ${d.exitCode}` : ""}`);
    if (d.failure) lines.push(`    ${oneLine(d.failure, 200)}`);
    for (const w of d.warnings ?? []) lines.push(`    warning: ${oneLine(w, 200)}`);
    for (const g of d.gates ?? []) {
      lines.push(`    gate ${g.name}: ${g.passed ? "passed" : "FAILED"} (${g.summary})`);
      if (!g.passed && g.output.trim() !== "") lines.push(indent(g.output.trimEnd(), "      | "));
    }
  }
  return lines.join("\n");
}

export function formatMerge(r: MergeResult): string {
  if (r.merged) return `merged ${r.taskId}${r.already ? " (already merged)" : ""}`;
  return `CONFLICT ${r.taskId}: ${(r.conflicts ?? []).join(", ")} (merge aborted, task blocked)`;
}

export function formatSummary(s: RunSummary): string {
  const counts = TASK_STATUSES.filter((st) => s.counts[st] > 0).map((st) => `${s.counts[st]} ${st}`);
  const lines = [`run ${s.runId}: ${counts.join(", ") || "no tasks"} (${s.dispatches} dispatch(es) started)`];
  for (const m of s.merges) lines.push(`  ${formatMerge(m)}`);
  if (s.attention.length > 0) {
    lines.push("needs attention:");
    for (const a of s.attention) lines.push(`  ${a.taskId} [${a.status}] ${oneLine(a.reason, 140)}`);
  }
  lines.push(s.complete ? "all tasks completed and merged into the integration branch" : "run is not complete");
  return lines.join("\n");
}

export function formatCleanup(entries: CleanupEntry[]): string {
  if (entries.length === 0) return "nothing to clean up";
  return entries
    .map((e) => {
      const branch = e.branch ? `, branch ${e.branch}` : "";
      return e.action === "removed" ? `removed ${e.runId}/${e.name}${branch}` : `skipped ${e.runId}/${e.name}: ${e.reason}`;
    })
    .join("\n");
}

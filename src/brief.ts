import type { GateResult, Run, Task } from "./types.js";

export interface BriefInput {
  run: Run;
  task: Task;
  dispatchId: string;
  attempt: number;
  branch: string;
  worktree: string;
  dependencies: { id: string; title: string; summary?: string }[];
  answers: { question: string; answer: string }[];
  decisions: { question: string; decision: string }[];
  gates: { name: string; command: string }[];
  previousFailure?: { dispatchId: string; reason: string; gates: GateResult[] };
  mergeConflict?: { files: string[]; integrationBranch: string };
}

/** Headings other tools (including the example worker) rely on. */
export const BRIEF_SPEC_HEADING = "## Task specification";

export function buildBrief(b: BriefInput): string {
  const out: string[] = [];
  out.push(`# Task brief: ${b.task.title}`);
  out.push("");
  out.push(`Run \`${b.run.id}\` | task \`${b.task.id}\` | dispatch \`${b.dispatchId}\` (attempt ${b.attempt})`);
  out.push(`Branch \`${b.branch}\`, worktree \`${b.worktree}\``);
  out.push("");
  out.push("## Objective");
  out.push("");
  out.push(b.run.objective);
  out.push("");
  out.push(BRIEF_SPEC_HEADING);
  out.push("");
  out.push(b.task.spec);
  out.push("");

  if (b.task.acceptance.length > 0) {
    out.push("## Acceptance criteria");
    out.push("");
    for (const a of b.task.acceptance) out.push(`- ${a}`);
    out.push("");
  }

  if (b.gates.length > 0) {
    out.push("## Quality gates");
    out.push("");
    out.push("These commands run in your worktree after you finish. The task only counts as done if all pass.");
    out.push("");
    for (const g of b.gates) out.push(`- \`${g.name}\`: \`${g.command}\``);
    out.push("");
  }

  if (b.dependencies.length > 0) {
    out.push("## Completed dependencies");
    out.push("");
    out.push("Their changes are already merged into the integration branch your worktree was created from.");
    out.push("");
    for (const d of b.dependencies) out.push(`- \`${d.id}\` ${d.title}${d.summary ? `: ${d.summary}` : ""}`);
    out.push("");
  }

  if (b.answers.length > 0) {
    out.push("## Answers to your earlier questions");
    out.push("");
    for (const a of b.answers) {
      out.push(`- Q: ${a.question}`);
      out.push(`  A: ${a.answer}`);
    }
    out.push("");
  }

  if (b.decisions.length > 0) {
    out.push("## Decisions made by the coordinator");
    out.push("");
    for (const d of b.decisions) {
      out.push(`- ${d.question}`);
      out.push(`  Decision: ${d.decision}`);
    }
    out.push("");
  }

  if (b.previousFailure) {
    out.push("## Previous attempt failed");
    out.push("");
    out.push(`Dispatch \`${b.previousFailure.dispatchId}\` did not pass: ${b.previousFailure.reason}`);
    out.push("Your earlier work is still on this branch. Fix the problems below instead of starting over.");
    out.push("");
    for (const g of b.previousFailure.gates.filter((x) => !x.passed)) {
      out.push(`### Gate \`${g.name}\` failed (${g.summary})`);
      out.push("");
      out.push(`Command: \`${g.command}\``);
      out.push("");
      out.push("```text");
      out.push(g.output.trimEnd() || "(no output)");
      out.push("```");
      out.push("");
    }
  }

  if (b.mergeConflict) {
    out.push("## Merge conflict");
    out.push("");
    out.push(`Merging this branch into \`${b.mergeConflict.integrationBranch}\` conflicted in:`);
    out.push("");
    for (const f of b.mergeConflict.files) out.push(`- \`${f}\``);
    out.push("");
    out.push(`Run \`git merge ${b.mergeConflict.integrationBranch}\` in your worktree, resolve the conflicts, and commit.`);
    out.push("");
  }

  out.push("## Worker contract");
  out.push("");
  out.push(`- Work only inside \`${b.worktree}\`. Commit your work; uncommitted changes are committed for you when you exit.`);
  out.push("- Do not modify files in `.cos/` except the ones named below. Do not touch other branches or worktrees.");
  out.push("- Exit with code 0 when done, non-zero if you could not do the task.");
  out.push("- Optional: write `.cos/result.json` as `{\"outcome\":\"success\"|\"failure\",\"summary\":string,\"filesModified\":string[]}`.");
  out.push("- Optional: touch `.cos/heartbeat` regularly if the coordinator enforces a heartbeat timeout.");
  out.push("- To ask the coordinator a question, write `.cos/question.json` as `{\"question\":string,\"options\":string[]?}`.");
  out.push("  Then either exit 0 without a result (you will be re-dispatched with the answer in this brief),");
  out.push("  or keep running and poll `.cos/answer.json` (`{\"messageId\":string,\"answer\":string}`).");
  out.push("- Structured copy of this brief: `.cos/task.json`.");
  out.push("");
  return out.join("\n");
}

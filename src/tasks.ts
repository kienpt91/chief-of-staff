import crypto from "node:crypto";
import { EXCLUDE_PATTERNS, WORKER_NAME_PATTERN, integrationBranchName, type Ctx } from "./context.js";
import { refreshReadiness, validateGraph } from "./dag.js";
import { CosError } from "./errors.js";
import { branchExists, ensureExcluded, git, gitTry, hasCommits } from "./git.js";
import { assertValidId, type Store } from "./store.js";
import type { Decision, Run, Task } from "./types.js";

export interface CreateRunInput {
  objective: string;
  id?: string;
  /** branch, tag or commit the run starts from; defaults to the current branch (or HEAD) */
  base?: string;
}

export function createRun(ctx: Ctx, input: CreateRunInput): Run {
  const objective = input.objective.trim();
  if (objective === "") throw new CosError("objective must not be empty");
  if (!hasCommits(ctx.repo.root)) {
    throw new CosError("the repository has no commits yet; create an initial commit first");
  }
  const id = input.id ?? `r-${crypto.randomBytes(3).toString("hex")}`;
  assertValidId("run", id);
  if (ctx.store.findRun(id)) throw new CosError(`run "${id}" already exists`);

  const head = gitTry(ctx.repo.root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const baseRef = input.base ?? (head.ok && head.stdout.trim() !== "" ? head.stdout.trim() : "HEAD");
  if (baseRef.startsWith("-")) throw new CosError(`invalid base "${baseRef}": it must not start with "-"`);
  const resolved = gitTry(ctx.repo.root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (!resolved.ok) throw new CosError(`cannot resolve base "${baseRef}" to a commit`);
  const baseCommit = resolved.stdout.trim();

  const integrationBranch = integrationBranchName(id);
  if (branchExists(ctx.repo.root, integrationBranch)) {
    throw new CosError(`branch ${integrationBranch} already exists`);
  }
  // creates a ref only: the user's working tree and current branch are untouched
  git(ctx.repo.root, ["branch", integrationBranch, baseCommit]);
  ensureExcluded(ctx.repo, EXCLUDE_PATTERNS);

  const run: Run = {
    id,
    objective,
    repoRoot: ctx.repo.root,
    baseRef,
    baseCommit,
    integrationBranch,
    createdAt: new Date().toISOString(),
    counters: { task: 0, dispatch: 0, message: 0, decision: 0 },
  };
  ctx.store.putRun(run);
  return run;
}

export interface TaskInput {
  id?: string;
  title: string;
  spec: string;
  after?: string[];
  acceptance?: string[];
  worker?: string;
  /** opens a decision gate: the task stays blocked until it is resolved */
  gate?: string;
}

export function refreshTx(store: Store, runId: string): void {
  const tasks = store.listTasks(runId);
  for (const t of refreshReadiness(tasks)) store.putTask(t);
}

/** Adds a batch of tasks atomically: either all are valid and stored, or nothing changes. */
export function addTasks(ctx: Ctx, runId: string, inputs: TaskInput[]): Task[] {
  ctx.store.getRun(runId);
  return ctx.store.tx(runId, (s) => {
    const existing = s.listTasks(runId);
    const taken = new Set(existing.map((t) => t.id));
    for (const i of inputs) if (i.id) taken.add(i.id);

    const resolved = inputs.map((input) => {
      const title = input.title?.trim() ?? "";
      const spec = input.spec?.trim() ?? "";
      if (title === "") throw new CosError("task title must not be empty");
      if (spec === "") throw new CosError(`task "${input.id ?? title}" needs a spec`);
      let id = input.id;
      if (id === undefined) {
        do {
          id = s.allocId(runId, "task", "t");
        } while (taken.has(id));
        taken.add(id);
      }
      assertValidId("task", id);
      if (id === "integration") throw new CosError('"integration" is a reserved task id');
      if (input.worker !== undefined && !WORKER_NAME_PATTERN.test(input.worker)) {
        throw new CosError(`task "${id}": invalid worker name "${input.worker}"`);
      }
      return { id, title, spec, input, after: input.after ?? [] };
    });

    validateGraph(
      existing,
      resolved.map((r) => ({ id: r.id, after: r.after })),
    );

    let order = existing.reduce((m, t) => Math.max(m, t.order), 0);
    const now = new Date().toISOString();
    const created: Task[] = [];
    for (const r of resolved) {
      const task: Task = {
        id: r.id,
        runId,
        title: r.title,
        spec: r.spec,
        acceptance: r.input.acceptance ?? [],
        after: r.after,
        worker: r.input.worker,
        status: "pending",
        attempts: 0,
        order: ++order,
        createdAt: now,
        updatedAt: now,
      };
      if (r.input.gate && r.input.gate.trim() !== "") {
        const decision = newDecision(s, runId, r.id, r.input.gate.trim(), undefined);
        task.status = "blocked";
        task.blocked = { kind: "decision", ref: decision.id, detail: decision.question };
      }
      s.putTask(task);
      created.push(task);
    }
    refreshTx(s, runId);
    return created.map((t) => s.getTask(runId, t.id));
  });
}

function newDecision(s: Store, runId: string, taskId: string, question: string, options: string[] | undefined): Decision {
  const decision: Decision = {
    id: s.allocId(runId, "decision", "g"),
    runId,
    taskId,
    question,
    options,
    status: "open",
    openedAt: new Date().toISOString(),
  };
  s.putDecision(decision);
  return decision;
}

export function openDecision(
  ctx: Ctx,
  runId: string,
  taskId: string,
  question: string,
  options?: string[],
): Decision {
  if (question.trim() === "") throw new CosError("decision question must not be empty");
  return ctx.store.tx(runId, (s) => {
    const task = s.getTask(runId, taskId);
    const allowed = ["pending", "ready", "failed"].includes(task.status) || task.blocked?.kind === "decision";
    if (!allowed) {
      throw new CosError(`task "${taskId}" is ${task.status}${task.blocked ? ` (${task.blocked.kind})` : ""}; a decision gate can only be opened on a pending, ready, failed or decision-blocked task`);
    }
    const decision = newDecision(s, runId, taskId, question.trim(), options);
    if (task.blocked?.kind !== "decision") {
      task.status = "blocked";
      task.blocked = { kind: "decision", ref: decision.id, detail: decision.question };
    }
    s.putTask(task);
    return decision;
  });
}

export function listDecisions(ctx: Ctx, runId: string, includeResolved = false): Decision[] {
  return ctx.store.listDecisions(runId).filter((d) => includeResolved || d.status === "open");
}

export function resolveDecision(ctx: Ctx, runId: string, decisionId: string, text: string): Decision {
  if (text.trim() === "") throw new CosError("a decision needs a non-empty text");
  return ctx.store.tx(runId, (s) => {
    const decision = s.findDecision(runId, decisionId);
    if (!decision) throw new CosError(`unknown decision gate "${decisionId}" in run "${runId}"`);
    if (decision.status === "resolved") throw new CosError(`decision gate "${decisionId}" is already resolved`);
    if (decision.options && decision.options.length > 0 && !decision.options.includes(text.trim())) {
      throw new CosError(`decision must be one of: ${decision.options.join(", ")}`);
    }
    decision.status = "resolved";
    decision.decision = text.trim();
    decision.resolvedAt = new Date().toISOString();
    s.putDecision(decision);

    const task = s.getTask(runId, decision.taskId);
    if (task.blocked?.kind === "decision") {
      const stillOpen = s.listDecisions(runId).find((d) => d.taskId === task.id && d.status === "open");
      if (stillOpen) {
        task.blocked = { kind: "decision", ref: stillOpen.id, detail: stillOpen.question };
      } else {
        task.blocked = undefined;
        task.status = "pending";
      }
      s.putTask(task);
    }
    refreshTx(s, runId);
    return decision;
  });
}

export function listTasksRefreshed(ctx: Ctx, runId: string): Task[] {
  ctx.store.getRun(runId);
  ctx.store.tx(runId, (s) => refreshTx(s, runId));
  return ctx.store.listTasks(runId);
}

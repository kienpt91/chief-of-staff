import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildBrief } from "./brief.js";
import {
  DEFAULT_WORKER_TIMEOUT_SEC,
  buildEnv,
  resolveInvocation,
  type Config,
  type Placeholders,
  type WorkerConfig,
} from "./config.js";
import { taskBranch, taskWorktreePath, type Ctx } from "./context.js";
import { topoOrder } from "./dag.js";
import { CosError } from "./errors.js";
import { atomicWrite, atomicWriteJson, readJson, tailText } from "./fsutil.js";
import { runGates } from "./gates.js";
import { branchExists, git, gitTry, identityArgs, isDirty } from "./git.js";
import { mergeTask } from "./merge.js";
import { processFingerprint, runProcess, type RunProcessResult } from "./process.js";
import { recoverOrphans } from "./recovery.js";
import { refreshTx } from "./tasks.js";
import type {
  Dispatch,
  DispatchStatus,
  FailureKind,
  GateResult,
  Run,
  Task,
  WorkerResult,
} from "./types.js";

export interface DispatchOptions {
  /** worker name from the config; defaults to the task's worker, then "default" */
  worker?: string;
}

/**
 * Runs one attempt of a task to its conclusion: worktree, brief, worker process, quality gates.
 * Resolves once the attempt is finished (completed, failed, or waiting for a question answer).
 */
export async function dispatchTask(
  ctx: Ctx,
  runId: string,
  taskId: string,
  opts: DispatchOptions = {},
): Promise<Dispatch> {
  recoverOrphans(ctx, runId);
  const run = ctx.store.getRun(runId);
  const task = ctx.store.getTask(runId, taskId);
  if (task.status !== "ready") {
    throw new CosError(`task "${taskId}" is ${task.status}${task.blocked ? ` (${task.blocked.kind})` : ""}; only ready tasks can be dispatched`);
  }
  const config = ctx.loadConfig();
  const workerName = opts.worker ?? task.worker ?? "default";
  const worker = config.workers[workerName];
  if (!worker) {
    const known = Object.keys(config.workers);
    throw new CosError(
      `no worker "${workerName}" in the configuration${known.length > 0 ? ` (available: ${known.join(", ")})` : "; add a \"workers\" entry to cos.config.json"}`,
    );
  }

  // Dependents branch from the integration branch, so dependencies must be merged into it first.
  const deps = topoOrder(ctx.store.listTasks(runId).filter((t) => task.after.includes(t.id)));
  for (const dep of deps) {
    if (dep.merged) continue;
    const res = await mergeTask(ctx, runId, dep.id);
    if (!res.merged) {
      throw new CosError(
        `dependency "${dep.id}" conflicts when merged into ${run.integrationBranch} (${(res.conflicts ?? []).join(", ")}); task "${taskId}" cannot start`,
      );
    }
    ctx.log(`merged dependency ${dep.id} into ${run.integrationBranch}`);
  }

  const dispatch = ctx.store.tx(runId, (s) => {
    const t = s.getTask(runId, taskId);
    if (t.status !== "ready") throw new CosError(`task "${taskId}" is ${t.status}; another dispatcher took it`);
    if (!t.after.every((d) => s.getTask(runId, d).status === "completed")) {
      throw new CosError(`task "${taskId}" has unfinished dependencies`);
    }
    const id = s.allocId(runId, "dispatch", "d");
    const d: Dispatch = {
      id,
      runId,
      taskId,
      attempt: t.attempts + 1,
      status: "running",
      worker: workerName,
      supervisorPid: process.pid,
      supervisorStart: processFingerprint(process.pid),
      startedAt: new Date().toISOString(),
    };
    s.putDispatch(d);
    t.status = "dispatched";
    t.attempts += 1;
    t.lastDispatchId = id;
    t.blocked = undefined;
    s.putTask(t);
    return d;
  });

  try {
    return await execute(ctx, run, config, dispatch, worker);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(ctx, runId, dispatch.id, { status: "failed", kind: "setup", failure: `dispatch setup failed: ${message}` });
  }
}

/** Re-dispatches a failed task (or a task whose merge conflicted); the brief carries the failure. */
export async function retryTask(ctx: Ctx, runId: string, taskId: string, opts: DispatchOptions = {}): Promise<Dispatch> {
  ctx.store.tx(runId, (s) => {
    const t = s.getTask(runId, taskId);
    const mergeBlocked = t.status === "blocked" && t.blocked?.kind === "merge-conflict";
    if (t.status !== "failed" && !mergeBlocked) {
      throw new CosError(`task "${taskId}" is ${t.status}; only failed tasks (or merge-conflicted ones) can be retried`);
    }
    const unfinished = t.after.filter((d) => s.getTask(runId, d).status !== "completed");
    if (unfinished.length > 0) throw new CosError(`task "${taskId}" has unfinished dependencies: ${unfinished.join(", ")}`);
    t.status = "ready";
    t.blocked = undefined;
    s.putTask(t);
  });
  return dispatchTask(ctx, runId, taskId, opts);
}

function ensureWorktree(ctx: Ctx, run: Run, task: Task): string {
  const wt = taskWorktreePath(ctx, run.id, task.id);
  if (fs.existsSync(path.join(wt, ".git"))) return wt;
  if (fs.existsSync(wt) && fs.readdirSync(wt).length > 0) {
    throw new CosError(`${wt} exists but is not a git worktree; remove it or run "cos cleanup"`);
  }
  gitTry(ctx.repo.root, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const branch = taskBranch(run.id, task.id);
  if (branchExists(ctx.repo.root, branch)) {
    git(ctx.repo.root, ["worktree", "add", wt, branch]);
  } else {
    git(ctx.repo.root, ["worktree", "add", "-b", branch, wt, run.integrationBranch]);
  }
  return wt;
}

function prepareCosDir(worktree: string, dispatchId: string): string {
  const cosDir = path.join(worktree, ".cos");
  fs.mkdirSync(cosDir, { recursive: true });
  const archive = path.join(cosDir, "history", `before-${dispatchId}`);
  for (const name of ["result.json", "question.json", "answer.json"]) {
    const src = path.join(cosDir, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(src, path.join(archive, name));
  }
  fs.rmSync(path.join(cosDir, "heartbeat"), { force: true });
  return cosDir;
}

function latestFailedDispatch(ctx: Ctx, runId: string, taskId: string, currentId: string): Dispatch | undefined {
  const previous = ctx.store
    .listDispatches(runId)
    .filter((d) => d.taskId === taskId && d.id !== currentId);
  const last = previous[previous.length - 1];
  if (last && ["failed", "timed_out", "stalled", "orphaned"].includes(last.status)) return last;
  return undefined;
}

async function execute(ctx: Ctx, run: Run, config: Config, dispatch: Dispatch, worker: WorkerConfig): Promise<Dispatch> {
  const runId = run.id;
  const task = ctx.store.getTask(runId, dispatch.taskId);
  const branch = taskBranch(runId, task.id);
  const worktree = ensureWorktree(ctx, run, task);
  const cosDir = prepareCosDir(worktree, dispatch.id);

  const allTasks = ctx.store.listTasks(runId);
  const messages = ctx.store.listMessages(runId);
  const previous = latestFailedDispatch(ctx, runId, task.id, dispatch.id);
  const vars: Placeholders = {
    briefPath: path.join(cosDir, "brief.md"),
    taskId: task.id,
    dispatchId: dispatch.id,
    worktree,
    repo: ctx.repo.root,
    runId,
  };
  const gateInfo = config.gates.map((g) => ({ name: g.name, command: resolveInvocation(g, vars).display }));

  const briefInput = {
    run,
    task,
    dispatchId: dispatch.id,
    attempt: dispatch.attempt,
    branch,
    worktree,
    dependencies: allTasks.filter((t) => task.after.includes(t.id)).map((t) => ({ id: t.id, title: t.title, summary: t.summary })),
    answers: messages
      .filter((m) => m.type === "question" && m.taskId === task.id && m.answer)
      .map((m) => ({ question: m.body, answer: m.answer?.text ?? "" })),
    decisions: ctx.store
      .listDecisions(runId)
      .filter((d) => d.taskId === task.id && d.status === "resolved")
      .map((d) => ({ question: d.question, decision: d.decision ?? "" })),
    gates: gateInfo,
    previousFailure: previous
      ? { dispatchId: previous.id, reason: previous.failure ?? previous.status, gates: previous.gates ?? [] }
      : undefined,
    mergeConflict: task.mergeConflict ? { files: task.mergeConflict.files, integrationBranch: run.integrationBranch } : undefined,
  };
  const brief = buildBrief(briefInput);
  atomicWrite(vars.briefPath, brief);
  atomicWrite(ctx.store.dispatchBriefPath(runId, dispatch.id), brief);
  atomicWriteJson(path.join(cosDir, "task.json"), {
    runId,
    taskId: task.id,
    dispatchId: dispatch.id,
    attempt: dispatch.attempt,
    title: task.title,
    spec: task.spec,
    acceptance: task.acceptance,
    objective: run.objective,
    branch,
    worktree,
    answers: briefInput.answers,
    decisions: briefInput.decisions,
    previousFailure: briefInput.previousFailure ?? null,
  });

  const inv = resolveInvocation(worker, vars);
  const logPath = ctx.store.dispatchLogPath(runId, dispatch.id);
  const cosEnv = {
    COS_RUN: runId,
    COS_TASK: task.id,
    COS_DISPATCH: dispatch.id,
    COS_BRIEF: vars.briefPath,
    COS_WORKTREE: worktree,
    COS_REPO: ctx.repo.root,
  };

  ctx.store.tx(runId, (s) => {
    const d = s.getDispatch(runId, dispatch.id);
    Object.assign(d, {
      command: inv.display,
      worktree,
      branch,
      briefPath: vars.briefPath,
      logPath,
      baseCommit: git(worktree, ["rev-parse", "HEAD"]),
    });
    s.putDispatch(d);
    s.addMessage({
      runId,
      type: "status",
      from: "coordinator",
      to: "coordinator",
      taskId: task.id,
      dispatchId: dispatch.id,
      body: `dispatched task ${task.id} (attempt ${dispatch.attempt}) to worker "${dispatch.worker}" on ${branch}`,
    });
  });
  ctx.log(`dispatch ${dispatch.id}: task ${task.id} (attempt ${dispatch.attempt}) started on ${branch}`);

  const seenQuestions = new Set<string>();
  const res = await runProcess({
    command: inv.command,
    args: inv.args,
    cwd: worktree,
    env: buildEnv(config, worker.env, vars, cosEnv),
    timeoutMs: (worker.timeoutSec ?? DEFAULT_WORKER_TIMEOUT_SEC) * 1000,
    killGraceMs: config.killGraceSec * 1000,
    stdoutPath: logPath,
    pollMs: ctx.pollMs,
    heartbeatFile: worker.heartbeatTimeoutSec !== undefined ? path.join(cosDir, "heartbeat") : undefined,
    heartbeatTimeoutMs: worker.heartbeatTimeoutSec !== undefined ? worker.heartbeatTimeoutSec * 1000 : undefined,
    onSpawn: (pid) => {
      ctx.store.tx(runId, (s) => {
        const d = s.getDispatch(runId, dispatch.id);
        d.pid = pid;
        d.pidStart = processFingerprint(pid);
        d.processStartedAt = new Date().toISOString();
        s.putDispatch(d);
      });
    },
    onTick: () => pollQuestion(ctx, runId, dispatch.id, task.id, cosDir, seenQuestions),
  });
  pollQuestion(ctx, runId, dispatch.id, task.id, cosDir, seenQuestions);

  return conclude(ctx, run, config, dispatch, worktree, cosDir, vars, cosEnv, res, worker);
}

/** Turns a new `.cos/question.json` into an inbox question message (once per distinct write). */
function pollQuestion(ctx: Ctx, runId: string, dispatchId: string, taskId: string, cosDir: string, seen: Set<string>): void {
  const file = path.join(cosDir, "question.json");
  let raw: string;
  let mtime: number;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return;
  }
  const signature = `${crypto.createHash("sha1").update(raw).digest("hex")}:${mtime}`;
  if (seen.has(signature)) return;
  let parsed: { question?: unknown; options?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return; // partially written; look again on the next tick
  }
  if (typeof parsed.question !== "string" || parsed.question.trim() === "") return;
  seen.add(signature);
  const options = Array.isArray(parsed.options) ? parsed.options.filter((o): o is string => typeof o === "string") : undefined;
  ctx.store.tx(runId, (s) => {
    const m = s.addMessage({
      runId,
      type: "question",
      from: `worker:${dispatchId}`,
      to: "coordinator",
      taskId,
      dispatchId,
      body: (parsed.question as string).trim(),
      payload: options && options.length > 0 ? { options } : undefined,
    });
    ctx.log(`dispatch ${dispatchId}: task ${taskId} asks ${m.id}: ${m.body}`);
  });
}

function readWorkerResult(cosDir: string): WorkerResult | undefined {
  let raw: unknown;
  try {
    raw = readJson<unknown>(path.join(cosDir, "result.json"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.outcome !== "success" && o.outcome !== "failure") return undefined;
  return {
    outcome: o.outcome,
    summary: typeof o.summary === "string" ? o.summary : undefined,
    filesModified: Array.isArray(o.filesModified) ? o.filesModified.filter((f): f is string => typeof f === "string") : undefined,
  };
}

function commitLeftovers(worktree: string, taskId: string, dispatchId: string): void {
  if (!isDirty(worktree)) return;
  git(worktree, ["add", "-A"]);
  git(worktree, [...identityArgs(worktree), "commit", "-m", `cos: uncommitted changes from task ${taskId} (${dispatchId})`]);
}

async function conclude(
  ctx: Ctx,
  run: Run,
  config: Config,
  dispatch: Dispatch,
  worktree: string,
  cosDir: string,
  vars: Placeholders,
  cosEnv: Record<string, string>,
  res: RunProcessResult,
  worker: WorkerConfig,
): Promise<Dispatch> {
  const runId = run.id;
  const taskId = dispatch.taskId;
  const result = readWorkerResult(cosDir);
  ctx.store.tx(runId, (s) => {
    const d = s.getDispatch(runId, dispatch.id);
    d.exitCode = res.exitCode;
    d.signal = res.signal;
    d.result = result;
    d.processEndedAt = new Date(res.endedAt).toISOString();
    s.putDispatch(d);
  });

  const unanswered = ctx.store
    .listMessages(runId)
    .filter((m) => m.type === "question" && m.dispatchId === dispatch.id && !m.answer);

  const timeoutSec = worker.timeoutSec ?? DEFAULT_WORKER_TIMEOUT_SEC;
  let failure: { status: DispatchStatus; kind: FailureKind; text: string } | undefined;
  if (res.spawnError) {
    failure = { status: "failed", kind: "spawn", text: `could not start worker: ${res.spawnError}` };
  } else if (res.timedOut) {
    failure = { status: "timed_out", kind: "timeout", text: `worker timed out after ${timeoutSec}s and its process group was killed` };
  } else if (res.stalled) {
    failure = { status: "stalled", kind: "stalled", text: `no heartbeat for ${worker.heartbeatTimeoutSec}s; worker process group was killed` };
  } else if (res.exitCode !== 0) {
    const how = res.signal
      ? `was killed by ${res.signal}`
      : `exited with code ${res.exitCode}${res.exitCode === 127 || res.exitCode === 126 ? " (command not found or not executable?)" : ""}`;
    failure = { status: "failed", kind: "worker", text: `worker ${how}${result?.summary ? `: ${result.summary}` : ""}` };
  } else if (result?.outcome === "failure") {
    failure = { status: "failed", kind: "worker", text: `worker reported failure${result.summary ? `: ${result.summary}` : ""}` };
  }

  const outcomeWord = failure ? "failed" : unanswered.length > 0 && !result ? "asked" : "done";
  if (outcomeWord !== "asked") {
    sendWorkerDone(ctx, runId, dispatch, outcomeWord, result?.summary ?? failure?.text, res.exitCode);
  }
  if (failure) return fail(ctx, runId, dispatch.id, { status: failure.status, kind: failure.kind, failure: failure.text });

  if (outcomeWord === "asked") {
    return ctx.store.tx(runId, (s) => {
      const d = s.getDispatch(runId, dispatch.id);
      d.status = "asked";
      d.endedAt = new Date().toISOString();
      s.putDispatch(d);
      const task = s.getTask(runId, taskId);
      const open = unanswered.map((m) => s.getMessage(runId, m.id)).find((m) => !m.answer);
      if (open) {
        task.status = "blocked";
        task.blocked = { kind: "question", ref: open.id, detail: open.body };
      } else {
        task.status = "pending"; // answered while we were wrapping up
      }
      s.putTask(task);
      refreshTx(s, runId);
      ctx.log(`dispatch ${dispatch.id}: task ${taskId} is waiting for an answer`);
      return d;
    });
  }

  commitLeftovers(worktree, taskId, dispatch.id);
  const headCommit = git(worktree, ["rev-parse", "HEAD"]);
  ctx.store.tx(runId, (s) => {
    const d = s.getDispatch(runId, dispatch.id);
    d.status = "gating";
    d.headCommit = headCommit;
    s.putDispatch(d);
    const t = s.getTask(runId, taskId);
    t.status = "review";
    t.summary = result?.summary ?? t.summary;
    s.putTask(t);
  });

  const gates = await runGates({
    config,
    vars,
    cosEnv,
    logDir: path.dirname(ctx.store.dispatchLogPath(runId, dispatch.id)),
    pollMs: ctx.pollMs,
  });
  const failed = gates.filter((g) => !g.passed);
  if (failed.length > 0) {
    const text = `quality gate failed: ${failed.map((g) => `${g.name} (${g.summary})`).join("; ")}`;
    return fail(ctx, runId, dispatch.id, { status: "failed", kind: "gate", failure: text, gates });
  }

  return ctx.store.tx(runId, (s) => {
    const d = s.getDispatch(runId, dispatch.id);
    d.status = "passed";
    d.gates = gates;
    d.endedAt = new Date().toISOString();
    s.putDispatch(d);
    const t = s.getTask(runId, taskId);
    t.status = "completed";
    t.failure = undefined;
    s.putTask(t);
    s.addMessage({
      runId,
      type: "status",
      from: "coordinator",
      to: "coordinator",
      taskId,
      dispatchId: dispatch.id,
      body: `task ${taskId} completed${gates.length > 0 ? ` (gates passed: ${gates.map((g) => g.name).join(", ")})` : " (no quality gates configured)"}`,
    });
    refreshTx(s, runId);
    ctx.log(`dispatch ${dispatch.id}: task ${taskId} completed`);
    return d;
  });
}

function sendWorkerDone(ctx: Ctx, runId: string, d: Dispatch, outcome: string, summary: string | undefined, exitCode: number | null): void {
  ctx.store.tx(runId, (s) => {
    s.addMessage({
      runId,
      type: "worker_done",
      from: `worker:${d.id}`,
      to: "coordinator",
      taskId: d.taskId,
      dispatchId: d.id,
      body: `worker for task ${d.taskId} ${outcome}${summary ? `: ${summary}` : ""}`,
      payload: { outcome, exitCode },
    });
  });
}

interface FailInput {
  status: DispatchStatus;
  kind: FailureKind;
  failure: string;
  gates?: GateResult[];
}

function fail(ctx: Ctx, runId: string, dispatchId: string, input: FailInput): Dispatch {
  return ctx.store.tx(runId, (s) => {
    const d = s.getDispatch(runId, dispatchId);
    d.status = input.status;
    d.failureKind = input.kind;
    d.failure = input.failure;
    if (input.gates) d.gates = input.gates;
    d.endedAt = new Date().toISOString();
    s.putDispatch(d);
    const t = s.getTask(runId, d.taskId);
    t.status = "failed";
    t.failure = input.failure;
    s.putTask(t);
    s.addMessage({
      runId,
      type: "escalation",
      from: "coordinator",
      to: "coordinator",
      taskId: d.taskId,
      dispatchId,
      body: `task ${d.taskId} failed (attempt ${d.attempt}): ${tailText(input.failure, 600)}. Use "cos retry --task ${d.taskId}" to re-dispatch with the failure appended to the brief.`,
      payload: { kind: input.kind },
    });
    refreshTx(s, runId);
    ctx.log(`dispatch ${dispatchId}: task ${d.taskId} failed: ${input.failure}`);
    return d;
  });
}
